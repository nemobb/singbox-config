/**
	*
	* 生成节点
	* https://github.com/immortalwrt/homeproxy/blob/master/root/etc/homeproxy/scripts/generate_client.uc
	*
	* 解析节点
	* https://github.com/immortalwrt/homeproxy/blob/master/htdocs/luci-static/resources/view/homeproxy/node.js
	*
	*/

const defaultFeatures = {
	with_quic: true,
	with_utls: true
}

const hp = {
	decodeBase64Str:function(str) {
    if (!str) return null;

    /* Thanks to luci-app-ssr-plus */
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    var padding = (4 - (str.length % 4)) % 4;
    if (padding) str = str + Array(padding + 1).join("=");

    return decodeURIComponent(
      Array.prototype.map
        .call(
          atob(str),
          (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2),
        )
        .join(""),
    );
  },
	shadowsocks_encrypt_methods: [
		/* Stream */
		'none',
		/* AEAD */
		'aes-128-gcm',
		'aes-192-gcm',
		'aes-256-gcm',
		'chacha20-ietf-poly1305',
		'xchacha20-ietf-poly1305',
		/* AEAD 2022 */
		'2022-blake3-aes-128-gcm',
		'2022-blake3-aes-256-gcm',
		'2022-blake3-chacha20-poly1305'
	],
}

function parseShareLink(uri, features=defaultFeatures) {
	let config, url, params;

	uri = uri.split('://');
	if (uri[0] && uri[1]) {
		switch (uri[0]) {
		case 'http':
		case 'https':
			url = new URL('http://' + uri[1]);

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'http',
				address: url.hostname,
				port: url.port || '80',
				username: url.username ? decodeURIComponent(url.username) : null,
				password: url.password ? decodeURIComponent(url.password) : null,
				tls: (uri[0] === 'https') ? '1' : '0'
			};

			break;
		case 'hysteria':
			/* https://github.com/HyNetwork/hysteria/wiki/URI-Scheme */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* WeChat-Video / FakeTCP are unsupported by sing-box currently */
			if (!features.with_quic || (params.get('protocol') && params.get('protocol') !== 'udp'))
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'hysteria',
				address: url.hostname,
				port: url.port || '80',
				hysteria_protocol: params.get('protocol') || 'udp',
				hysteria_auth_type: params.get('auth') ? 'string' : null,
				hysteria_auth_payload: params.get('auth'),
				hysteria_obfs_password: params.get('obfsParam'),
				hysteria_down_mbps: params.get('downmbps'),
				hysteria_up_mbps: params.get('upmbps'),
				tls: '1',
				tls_sni: params.get('peer'),
				tls_alpn: params.get('alpn'),
				tls_insecure: params.get('insecure') ? '1' : '0'
			};

			break;
		case 'hysteria2':
		case 'hy2':
			/* https://v2.hysteria.network/docs/developers/URI-Scheme/ */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			if (!features.with_quic)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'hysteria2',
				address: url.hostname,
				port: url.port || '80',
				password: url.username ? (
					decodeURIComponent(url.username + (url.password ? (':' + url.password) : ''))
				) : null,
				hysteria_obfs_type: params.get('obfs'),
				hysteria_obfs_password: params.get('obfs-password'),
				tls: '1',
				tls_sni: params.get('sni'),
				tls_insecure: params.get('insecure') ? '1' : '0'
			};

			break;
		case 'socks':
		case 'socks4':
		case 'socks4a':
		case 'socsk5':
		case 'socks5h':
			url = new URL('http://' + uri[1]);

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'socks',
				address: url.hostname,
				port: url.port || '80',
				username: url.username ? decodeURIComponent(url.username) : null,
				password: url.password ? decodeURIComponent(url.password) : null,
				socks_version: (uri[0].includes('4')) ? '4' : '5'
			};

			break;
		case 'ss':
			try {
				/* "Lovely" Shadowrocket format */
				try {
					let suri = uri[1].split('#'), slabel = '';
					if (suri.length <= 2) {
						if (suri.length === 2)
							slabel = '#' + suri[1];
						uri[1] = hp.decodeBase64Str(suri[0]) + slabel;
					}
				} catch(e) { }

				/* SIP002 format https://shadowsocks.org/guide/sip002.html */
				url = new URL('http://' + uri[1]);

				let userinfo;
				if (url.username && url.password)
					/* User info encoded with URIComponent */
					userinfo = [url.username, decodeURIComponent(url.password)];
				else if (url.username)
					/* User info encoded with base64 */
					userinfo = hp.decodeBase64Str(decodeURIComponent(url.username)).split(':');

				if (!hp.shadowsocks_encrypt_methods.includes(userinfo[0]))
					return null;

				let plugin, plugin_opts;
				if (url.search && url.searchParams.get('plugin')) {
					let plugin_info = url.searchParams.get('plugin').split(';');
					plugin = plugin_info[0];
					plugin_opts = plugin_info.slice(1) ? plugin_info.slice(1).join(';') : null;
				}

				config = {
					label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
					type: 'shadowsocks',
					address: url.hostname,
					port: url.port || '80',
					shadowsocks_encrypt_method: userinfo[0],
					password: userinfo[1],
					shadowsocks_plugin: plugin,
					shadowsocks_plugin_opts: plugin_opts
				};
			} catch(e) {
				/* Legacy format https://github.com/shadowsocks/shadowsocks-org/commit/78ca46cd6859a4e9475953ed34a2d301454f579e */
				uri = uri[1].split('@');
				if (uri.length < 2)
					return null;
				else if (uri.length > 2)
					uri = [ uri.slice(0, -1).join('@'), uri.slice(-1).toString() ];

				config = {
					type: 'shadowsocks',
					address: uri[1].split(':')[0],
					port: uri[1].split(':')[1],
					shadowsocks_encrypt_method: uri[0].split(':')[0],
					password: uri[0].split(':').slice(1).join(':')
				};
			}

			break;
		case 'trojan':
			/* https://p4gefau1t.github.io/trojan-go/developer/url/ */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Check if password exists */
			if (!url.username)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'trojan',
				address: url.hostname,
				port: url.port || '80',
				password: decodeURIComponent(url.username),
				transport: params.get('type') !== 'tcp' ? params.get('type') : null,
				tls: '1',
				tls_sni: params.get('sni')
			};
			switch (params.get('type')) {
			case 'grpc':
				config.grpc_servicename = params.get('serviceName');
				break;
			case 'ws':
				config.ws_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.ws_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		case 'tuic':
			/* https://github.com/daeuniverse/dae/discussions/182 */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Check if uuid exists */
			if (!url.username)
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'tuic',
				address: url.hostname,
				port: url.port || '80',
				uuid: url.username,
				password: url.password ? decodeURIComponent(url.password) : null,
				tuic_congestion_control: params.get('congestion_control'),
				tuic_udp_relay_mode: params.get('udp_relay_mode'),
				tls: '1',
				tls_sni: params.get('sni'),
				tls_alpn: params.get('alpn') ? decodeURIComponent(params.get('alpn')).split(',') : null
			};

			break;
		case 'vless':
			/* https://github.com/XTLS/Xray-core/discussions/716 */
			url = new URL('http://' + uri[1]);
			params = url.searchParams;

			/* Unsupported protocol */
			if (params.get('type') === 'kcp')
				return null;
			else if (params.get('type') === 'quic' && ((params.get('quicSecurity') && params.get('quicSecurity') !== 'none') || !features.with_quic))
				return null;
			/* Check if uuid and type exist */
			if (!url.username || !params.get('type'))
				return null;

			config = {
				label: url.hash ? decodeURIComponent(url.hash.slice(1)) : null,
				type: 'vless',
				address: url.hostname,
				port: url.port || '80',
				uuid: url.username,
				transport: params.get('type') !== 'tcp' ? params.get('type') : null,
				tls: ['tls', 'xtls', 'reality'].includes(params.get('security')) ? '1' : '0',
				tls_sni: params.get('sni'),
				tls_alpn: params.get('alpn') ? decodeURIComponent(params.get('alpn')).split(',') : null,
				tls_reality: (params.get('security') === 'reality') ? '1' : '0',
				tls_reality_public_key: params.get('pbk') ? decodeURIComponent(params.get('pbk')) : null,
				tls_reality_short_id: params.get('sid'),
				tls_utls: features.with_utls ? params.get('fp') : null,
				vless_flow: ['tls', 'reality'].includes(params.get('security')) ? params.get('flow') : null
			};
			switch (params.get('type')) {
			case 'grpc':
				config.grpc_servicename = params.get('serviceName');
				break;
			case 'http':
			case 'tcp':
				if (config.transport === 'http' || params.get('headerType') === 'http') {
					config.http_host = params.get('host') ? decodeURIComponent(params.get('host')).split(',') : null;
					config.http_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				}
				break;
			case 'httpupgrade':
				config.httpupgrade_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.http_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				break;
			case 'ws':
				config.ws_host = params.get('host') ? decodeURIComponent(params.get('host')) : null;
				config.ws_path = params.get('path') ? decodeURIComponent(params.get('path')) : null;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		case 'vmess':
			/* "Lovely" shadowrocket format */
			if (uri.includes('&'))
				return null;

			/* https://github.com/2dust/v2rayN/wiki/Description-of-VMess-share-link */
			uri = JSON.parse(hp.decodeBase64Str(uri[1]));

			if (uri.v != '2')
				return null;
			/* Unsupported protocols */
			else if (uri.net === 'kcp')
				return null;
			else if (uri.net === 'quic' && ((uri.type && uri.type !== 'none') || !features.with_quic))
				return null;
			/* https://www.v2fly.org/config/protocols/vmess.html#vmess-md5-%E8%AE%A4%E8%AF%81%E4%BF%A1%E6%81%AF-%E6%B7%98%E6%B1%B0%E6%9C%BA%E5%88%B6
			 * else if (uri.aid && parseInt(uri.aid) !== 0)
			 * 	return null;
			 */

			config = {
				label: uri.ps,
				type: 'vmess',
				address: uri.add,
				port: uri.port,
				uuid: uri.id,
				vmess_alterid: uri.aid,
				vmess_encrypt: uri.scy || 'auto',
				transport: (uri.net !== 'tcp') ? uri.net : null,
				tls: uri.tls === 'tls' ? '1' : '0',
				tls_sni: uri.sni || uri.host,
				tls_alpn: uri.alpn ? uri.alpn.split(',') : null,
				tls_utls: features.with_utls ? uri.fp : null
			};
			switch (uri.net) {
			case 'grpc':
				config.grpc_servicename = uri.path;
				break;
			case 'h2':
			case 'tcp':
				if (uri.net === 'h2' || uri.type === 'http') {
					config.transport = 'http';
					config.http_host = uri.host ? uri.host.split(',') : null;
					config.http_path = uri.path;
				}
				break;
			case 'httpupgrade':
				config.httpupgrade_host = uri.host;
				config.http_path = uri.path;
				break;
			case 'ws':
				config.ws_host = uri.host;
				config.ws_path = uri.path;
				if (config.ws_path && config.ws_path.includes('?ed=')) {
					config.websocket_early_data_header = 'Sec-WebSocket-Protocol';
					config.websocket_early_data = config.ws_path.split('?ed=')[1];
					config.ws_path = config.ws_path.split('?ed=')[0];
				}
				break;
			}

			break;
		}
	}

	if (config) {
		if (!config.address || !config.port)
			return null;
		else if (!config.label)
			config.label = config.address + ':' + config.port;

		config.address = config.address.replace(/\[|\]/g, '');
	}

	return config;
}

function generateOutbound(node) {
	if (!node || !node.type) {
		return null
	}
	const outbound = {
		type: node.type,
		tag: node.label,
		server:  node.address,
		server_port: +node.port,
	}
	switch(node.type) {
		case 'socks':
			Object.assign(outbound, {
				version: node.socks_version,
				username: node.username,
				password: node.password
			})
			break;
		case 'http':
			Object.assign(outbound, {
				username: node.username,
				password: node.password
			})
			break;
		case 'shadowsocks':
			Object.assign(outbound, {
				password: node.password,
				method: node.shadowsocks_encrypt_method,
				plugin: node.shadowsocks_plugin,
				plugin_opts: node.shadowsocks_plugin_opts
			})
			break;
		case 'vmess':
			Object.assign(outbound, {
				uuid: node.uuid,
				alter_id: node.vmess_alterid,
				security: node.vmess_encrypt,
			})
			break;
		case 'trojan':
			Object.assign(outbound, {
				password: node.password,
			})
			break;
		case 'hysteria':
			Object.assign(outbound, {
				hop_interval: node.hysteria_hop_interval ? (node.hysteria_hop_interval+'s'):null,
			  up_mbps: +node.hysteria_up_mbps,
				down_mbps: +node.hysteria_down_mbps,
				obfs: node.hysteria_obfs_password,
				auth_str: (node.hysteria_auth_type === 'string') ? node.hysteria_auth_payload : null,
			})
			break;
		case 'hysteria2':
			Object.assign(outbound, {
				password: node.password,
				obfs: {
					type: node.hysteria_obfs_type,
					password: node.hysteria_obfs_password
				},
			})
			break;
		case 'vless':
			Object.assign(outbound, {
				uuid: node.uuid,
				flow: node.vless_flow,
			})
			break;
		case 'tuic':
			Object.assign(outbound, {
				uuid: node.uuid,
				password: node.password,
				congestion_control: node.tuic_congestion_control,
				udp_relay_mode: node.tuic_udp_relay_mode,
			})
			break;
		// XXX 没有实现这种解析
		case 'shadowtls':
			Object.assign(outbound, {
				version: 3,
				password: node.password,
			})
			break;
		// XXX 没有实现这种解析
		case 'anytls':
			Object.assign(outbound, {
				password: node.password,
			})
			break;
		// XXX 没有实现这种解析
		case 'tor':
			Object.assign(outbound, {
				data_directory: "$HOME/.cache/tor"
			})
			break;
		// XXX 没有实现这种解析
		case 'ssh':
			Object.assign(outbound, {
				user: node.username,
				password: node.password,
			})
			break;
		default:
			break;
	}

	if (node.tls === '1') {
		outbound.tls = {
      enabled: true,
      server_name: node.tls_sni,
      insecure: node.tls_insecure === "1",
      alpn: node.tls_alpn,
      min_version: node.tls_min_version, // XXX
      max_version: node.tls_max_version, // XXX
      cipher_suites: node.tls_cipher_suites, // XXX
      certificate_path: node.tls_cert_path, // XXX
      ech:
        node.tls_ech === "1"
          ? {
              enabled: true,
              pq_signature_schemes_enabled: node.tls_ech_enable_pqss === "1",
              config: node.tls_ech_config,
              config_path: node.tls_ech_config_path,
            }
          : null,
      utls: (node.tls_utls)
        ? {
            enabled: true,
            fingerprint: node.tls_utls,
          }
        : null,
      reality:
        node.tls_reality === "1"
          ? {
              enabled: true,
              public_key: node.tls_reality_public_key,
              short_id: node.tls_reality_short_id,
            }
          : null,
    };
	}

	if (node.transport) {
		outbound.transport = {
      type: node.transport,
      host: node.http_host || node.httpupgrade_host,
      path: node.http_path || node.ws_path,
      headers: node.ws_host
        ? {
            Host: node.ws_host,
          }
        : null,
      method: node.http_method,
      max_early_data: Number(node.websocket_early_data),
      early_data_header_name: node.websocket_early_data_header,
      service_name: node.grpc_servicename,
			// XXX
      idle_timeout: node.http_idle_timeout
        ? node.http_idle_timeout + "s"
        : null,
      ping_timeout: node.http_ping_timeout
        ? node.http_ping_timeout + "s"
        : null,
      permit_without_stream: Boolean(node.grpc_permit_without_stream),
    };
	}

	// XXX
	if (node.udp_over_tcp === '1') {
		outbound.udp_over_tcp = {
			enabled: true,
			version: Number(node.udp_over_tcp_version)
		}
	}
	if (node.tcp_fast_open) {
		outbound.tcp_fast_open = Boolean(node.tcp_fast_open)
	}
	if (node.tcp_multi_path) {
		outbound.tcp_multi_path = Boolean(node.tcp_multi_path)
	}
	if (node.udp_fragment) {
		outbound.udp_fragment = Boolean(node.udp_fragment)
	}

	return outbound
}

module.exports = {
	generateOutbound,
	parseShareLink
}
