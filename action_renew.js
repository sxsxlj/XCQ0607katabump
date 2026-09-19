const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 确保截图目录存在
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) {
    fs.mkdirSync(photoDir, { recursive: true });
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration & VLESS Support ---
let HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

// 解析 VLESS 链接并启动本地 Xray 转发服务
function setupVlessProxy(vlessUrlStr) {
    try {
        console.log('[代理] 检测到 VLESS 协议链接，正在解析配置...');
        const urlObj = new URL(vlessUrlStr);
        const uuid = urlObj.username;
        const address = urlObj.hostname;
        const port = parseInt(urlObj.port) || 443;
        const params = urlObj.searchParams;

        const encryption = params.get('encryption') || 'none';
        const security = params.get('security') || 'none';
        const sni = params.get('sni') || address;
        const type = params.get('type') || 'tcp';
        const host = params.get('host') || sni;
        const pathStr = params.get('path') || '/';

        const xrayConfig = {
            inbounds: [{
                port: 10809,
                listen: "127.0.0.1",
                protocol: "http",
                settings: { auth: "noauth" }
            }],
            outbounds: [{
                protocol: "vless",
                settings: {
                    vnext: [{
                        address: address,
                        port: port,
                        users: [{ id: uuid, encryption: encryption }]
                    }]
                },
                streamSettings: {
                    network: type,
                    security: security,
                    tlsSettings: security === 'tls' ? { serverName: sni, allowInsecure: false } : undefined,
                    wsSettings: type === 'ws' ? { path: pathStr, headers: { Host: host } } : undefined
                }
            }]
        };

        const configFile = '/tmp/xray_vless_config.json';
        fs.writeFileSync(configFile, JSON.stringify(xrayConfig, null, 2));

        console.log('[代理] 正在启动后台 Xray 服务转换 VLESS...');
        const xrayProcess = spawn('xray', ['run', '-config', configFile], { detached: true, stdio: 'ignore' });
        xrayProcess.unref();

        // 等待 2 秒确保 Xray 启动完成
        execSync('sleep 2');

        console.log('[代理] VLESS 已转接至本地 HTTP 代理 127.0.0.1:10809');
        return { server: 'http://127.0.0.1:10809' };
    } catch (e) {
        console.error('[代理] VLESS 自动解析/启动失败:', e.message);
        process.exit(1);
    }
}

if (HTTP_PROXY) {
    if (HTTP_PROXY.startsWith('vless://')) {
        PROXY_CONFIG = setupVlessProxy(HTTP_PROXY);
    } else {
        try {
            if (!HTTP_PROXY.startsWith('http://') && !HTTP_PROXY.startsWith('https://')) {
                HTTP_PROXY = `http://${HTTP_PROXY}`;
            }
            const proxyUrl = new URL(HTTP_PROXY);
            PROXY_CONFIG = {
                server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
                username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
                password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
            };
            console.log(`[代理] 检测到标准 HTTP 配置: 服务器=${PROXY_CONFIG.server}`);
        } catch (e) {
            console.error('[代理] 代理格式错误，解析失败');
            process.exit(1);
        }
    }
}

// 后续功能保持不变...
