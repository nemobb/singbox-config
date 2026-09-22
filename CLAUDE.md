# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the HTTP server on `0.0.0.0:5300` (no build step, no dependencies, no test suite, no linter). Requires Node >= 24.
- `docker build -t singbox-config . && docker run -d -p 5300:5300 singbox-config`.
- Manual smoke test: `curl 'http://localhost:5300/api/singbox'` — the bundled [defaults/config.json](defaults/config.json) has nodes, so this works with nothing mounted.
- Releases are driven entirely by git tags: pushing `v<semver>` builds and pushes the Docker image. Nothing else triggers CI, so ordinary pushes to `main` publish nothing. The release flow is: bump `package.json`'s `version` → commit → `git tag v<same version>` → `git push --tags`. CI fails if the tag and `package.json` disagree, and a prerelease tag (`v1.1.0-rc.1`) publishes the version tag but not `latest`.
- The Docker Hub repository description is **not** synced by CI; paste README into the web UI when it changes materially. Automating it needs a Delete-scoped PAT, and Docker Hub PATs are account-wide rather than per-repository, so that credential would let anyone holding it wipe every repo on the account.

## Architecture

Zero-dependency Node.js service (plain `node:http`) that turns proxy share links / subscription URLs into a complete sing-box client config JSON. Two files carry all the logic:

- **[node.js](node.js)** — protocol layer, ported from OpenWrt [homeproxy](https://github.com/immortalwrt/homeproxy). Two pure functions, no I/O:
  - `parseShareLink(uri, features)` — parses `vless://`, `vmess://`, `trojan://`, `ss://`, `hysteria(2)://`, `tuic://`, `anytls://`, `socks://`, `http(s)://` into homeproxy's flat intermediate shape (`tls_sni`, `ws_path`, `vless_flow`, … with `'1'`/`'0'` strings for booleans). Returns `null` for unsupported/malformed links, and for protocols `features` disables.
  - `generateOutbound(node)` — maps that flat shape onto a sing-box `outbounds[]` entry (nested `tls`, `transport`, `reality`, `utls` objects).

  **Read the file header before editing it.** It records the upstream commit each half was synced from, the three local divergences that must survive a re-sync, and the helper contract: `strToBool`/`strToInt`/`strToTime` return `null` for "omit this field" — writing `Boolean()`/`Number()` instead leaves `false`/`NaN` in the output, which sing-box rejects outright. That mistake shipped once and broke every ws node.

  `generateOutbound` is flat rather than per-type, like upstream, so several fields it emits are only legal on some outbound types (`tls` not on socks/shadowsocks, `transport` only on vless/vmess/trojan, `udp_over_tcp` only on socks/shadowsocks, and the transport sub-fields). The comment above the function has the verified table. Safety rests entirely on `parseShareLink` never producing those values for the wrong type.

- **[index.js](index.js)** — HTTP server and assembly. Pipeline: pick a *template*, pick a *config*, then `generateSingboxConfig` folds node groups into the template.
  - `resolveIn(baseDir, name)` is the only way user input becomes a path. Two layers: a `[\w-]{1,64}` whitelist (sufficient on its own — `.` and `/` can't get in), then a `path.relative` bounds check kept as a fallback for if the whitelist is ever loosened to allow subdirectories. Symlinks are deliberately *not* resolved — writing one into a mounted dir requires host write access already.
  - `loadJson` returns a `{ok, data}` / `{ok, reason}` result; `sendError` maps `reason` to 400 (bad name) / 404 (missing) / 500 (bad JSON) and keeps paths out of the response body — they go to the log only.
  - `updateOutbounds` mutates the template in place: appends each group's outbounds plus a `selector` named after the group, pushes the group tag into the outbound tagged `GLOBAL`, and pushes every individual node tag into the one tagged `AUTO`. **A template must contain outbounds tagged `GLOBAL` and `AUTO`** or grouping silently does nothing (`?.` swallows it). Losing `GLOBAL` is the worse half: `route.final` still names it, and `sing-box check` does not validate that reference, so the config passes every check and simply blackholes traffic. `checkTemplates()` warns about both at startup — startup only, so a template dropped into a mounted `templates/` afterwards is never checked.
  - `updateOutbounds` also deduplicates tags against everything already in the template. sing-box refuses a config with duplicate outbound tags, and collisions are routine: same remark twice in one subscription, two airports both naming a node `香港01`, or a node called `AUTO`.
  - Templates and configs are deep-cloned per request (`JSON.parse(JSON.stringify(...))`) precisely because of that mutation — never hold a reference to the shared bundled objects across requests.
  - `getSingboxOutbound` round-trips through `JSON.stringify` with a replacer stripping `null`/`undefined`/`""` (upstream's `removeBlankAttrs`), so `generateOutbound` can emit optional fields unconditionally. It returns `null` — never throws — for a link that fails to parse or that the target version can't use; callers `.filter(Boolean)`. One malformed link in a subscription must not fail the whole request.
  - Subscription fetching tries JSON first (Shadowsocks SIP008, incl. a `{servers: [...]}` wrapper); on parse failure it falls back to base64-decoding a newline-separated share-link list. Fetch failures are logged and that group is dropped; the rest of the config is still returned, unless nothing usable is left (see below).
  - Empty groups are skipped (an empty `selector` is an invalid config) and a request that yields no usable node at all returns 400 rather than a node-less config.

### Directory contract

```
defaults/   bundled config, per-version templates, versions.json; code, never mounted over
profiles/   user node configs, ?profile=<name>   — mount point, empty in the image
templates/  user templates,    ?template=<name>  — mount point, empty in the image
```

The split exists so a `-v host:/app/templates` bind mount can't shadow the bundled defaults (mounting a directory replaces its whole contents). Anything the program needs to boot belongs in `defaults/`; `profiles/` and `templates/` are purely user data. Both are overridable via `PROFILE_DIR` / `TEMPLATE_DIR` env vars for non-Docker deployments.

### Request surface

- `GET /api/singbox` — node sources from `?profile=<name>` → `profiles/<name>.json`, else [defaults/config.json](defaults/config.json). Profile shape: `{ custom: { name, nodes: [shareLink] }, subscriptions: [{ name, url }] }`.
  [defaults/config.json](defaults/config.json) is the CI fixture rather than a user-facing sample (the README carries its own short one). Its `custom.nodes` holds an `EXAMPLE-*` link for every branch `parseShareLink` has — each scheme, each transport including plain `tcp`, plus reality, flow, alpn, ws early-data, the ss `plugin` form and both socks versions — all pointing at `example.com`. The check job simply calls `/api/singbox` with no profile, so a bad edit fails the release. **Preserve that coverage when touching it**: several entries exist because the corresponding bug shipped once — vmess for `alter_id`, the ss `plugin` link for `plugin_opts`, the `?ed=` link for `max_early_data`, `socks5` for a scheme typo, and the ws/grpc/httpupgrade trio for the per-type transport fields. anytls additionally exercises version gating: it drops out below 1.12.

  Its `subscriptions` point at two files on Cloudflare R2 (`pub-deed7b2a6a584107946c12698ffe9627.r2.dev`): `subscription.txt`, a base64 share-link list, and `subscription-sip008.json`. They exist so CI exercises the whole fetch path — `fetchSubscription`, `checkUrl` against real DNS, both decode branches, and cross-group tag dedup — none of which `custom.nodes` alone can reach. They also cover the Shadowrocket fully-encoded `ss://` form that `custom.nodes` does not.

  > **This is the build's only external dependency.** If those objects are deleted, renamed, or R2 is unreachable, the release job fails for reasons unrelated to the change being released. The bucket is not managed by this repo — the files' content is reproducible from this description, but nothing here re-uploads them. Emptying `subscriptions` restores a fully self-contained build; `custom.nodes` still covers every parse branch on its own.
- `GET /api/singbox/sub?name=…&url=…` (repeatable pairs, positionally matched) — node sources from the query string only.

Template selection on both routes: `?template=<name>` uses `templates/<name>.json` and then no version tailoring happens (the caller owns that pairing); otherwise `?singbox=<version>` picks a bundled one. An unsupported version is a 400 listing what is supported.

`custom.name` and each `subscriptions[].name` become selector tags.

### sing-box versions

sing-box configs are not backward compatible and each version's features are unavailable in older ones, so bundled templates are maintained per version. [defaults/versions.json](defaults/versions.json) is the single source of truth:

```json
{ "default": "1.14",
  "templates": { "1.11": "template-v111", "1.12": "template-v113", … },
  "features":  { "with_anytls": "1.12" } }
```

`templates` maps a version to a file in `defaults/` — several versions may share one file, so the file count tracks real incompatibilities rather than version count. `features` gives each protocol's minimum version; `resolveFeatures` turns the requested version into the `features` object `parseShareLink` takes, so a node the target can't run is dropped instead of poisoning the config. Adding a version = drop in a template, add a line to each map; no code change.

CI checks the generated config against `v<default>.0` — the **oldest** patch of the default line, since `?singbox=1.14` promises any 1.14.x works. It covers only that one version, so run the others locally when adding a protocol or a template.

A bundled template is a full sing-box config (DNS, a tun inbound, route rules with remote `rule_set`s, clash-api). `outbounds` ships only `direct-out`, the `GLOBAL` selector and the `AUTO` urltest — everything else is injected per request. The three differ beyond the DNS block that forced the split: they carry different `rule_set` lists, and `template-v114` adds a top-level `http_clients` that only 1.14 understands. Diff them before assuming a change applies to all.

### Fetching subscriptions

`/api/singbox/sub` fetches caller-supplied URLs, so `fetchSubscription` guards it: `AbortSignal.timeout`, a streamed size cap (`content-length` can lie), a redirect cap, and `checkUrl` rejecting non-http(s) schemes plus private/reserved ranges — resolved via DNS first, so a public hostname pointing at `127.0.0.1` is still caught.

**`checkUrl` runs on every hop.** `redirect: "manual"` exists for exactly that; letting `fetch` follow redirects itself would let a 302 to `169.254.169.254` through. The reserved-range list is wider than the obvious ones — `2001:db8::/32` is in it because Docker guides routinely use the documentation prefix as an internal IPv6 range, which most SSRF filters miss.

The count cap (`MAX_SUBSCRIPTIONS`) sits one level up in `generateSingboxConfig`, since it bounds how many fetches a single request may fan out into.

`ALLOW_PRIVATE_NETWORK=1` disables the range check. It is only for a deployment reachable solely from a trusted network; a container can usually reach the host, its sibling containers and the whole LAN.

The `User-Agent` matters: many airports content-negotiate on it and answer a `sing-box` UA with a ready-made sing-box config, which this service cannot parse — it wants a base64 share-link list or SIP008. Hence the `v2rayN` default in `SUBSCRIPTION_USER_AGENT`. Do not "fix" it to `sing-box`.

Auth is a `TOKEN` env var checked against a `token` query param (clients can only supply a URL, so it can't be a header). Unset means no check.

## Adding a protocol

Six places, in this order:

1. `parseShareLink` in [node.js](node.js) — the parse branch. Follow upstream homeproxy's field naming; if upstream already supports it, port that branch verbatim.
2. `generateOutbound` in [node.js](node.js) — the outbound branch. It may already exist with an `XXX 没有实现这种解析` marker (anytls did); drop the marker once parsing lands.
3. [defaults/config.json](defaults/config.json) — an `EXAMPLE-*` link. **This is the step that gets forgotten**, and nothing complains: the protocol simply ships with no CI coverage at all.
4. [defaults/versions.json](defaults/versions.json) — only if the protocol needs a minimum sing-box version; add it to `features` and a `features.with_*` default in `node.js`, then gate the parse branch on it.
5. README's 支持的协议 line.
6. CHANGELOG's protocol list.

Nothing enforces any of this, so check it by hand. Verify locally against every version in `versions.json`, not just the default, since CI only covers the default one.

## Conventions

- `.editorconfig`: 2-space indent, LF, final newline. `node.js` predates this and uses tabs — leave its style alone when editing it.
- JSDoc comments and inline comments are written in Chinese; match that in these files.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `style:`).
