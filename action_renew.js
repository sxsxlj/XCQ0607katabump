const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

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

// --- 代理配置与 VLESS 支持 (你需要的节点逻辑) ---
let HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

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

        execSync('sleep 3');
        console.log('[代理] VLESS 已转接至本地 HTTP 代理 127.0.0.1:10809');
        return { server: 'http://127.0.0.1:10809' };
    } catch (e) {
        console.error('[代理] VLESS 自动解析/启动失败:', e.message);
        process.exit(1);
    }
}

async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[代理] 正在验证代理连接...');
    try {
        const proxyUrl = new URL(PROXY_CONFIG.server);
        const axiosConfig = {
            proxy: {
                protocol: proxyUrl.protocol.replace(':', ''),
                host: proxyUrl.hostname,
                port: proxyUrl.port,
            },
            timeout: 15000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        const res = await axios.get('https://www.google.com', axiosConfig);
        console.log(`[代理] 连接成功！HTTP 状态码: ${res.status}`);
        return true;
    } catch (error) {
        console.error(`[代理] 验证失败: ${error.message}`);
        return false;
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
            console.error('[代理] 格式错误');
            process.exit(1);
        }
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--lang=en-US,en'
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            const users = Array.isArray(parsed) ? parsed : (parsed.users || []);
            
            users.forEach(u => {
                if (u.username && u.username.length > 2) {
                    console.log(`::add-mask::${u.username}`);
                }
                if (u.password && u.password.length > 2) {
                    console.log(`::add-mask::${u.password}`);
                }
            });

            return users;
        }
    } catch (e) {
        console.error('解析 USERS_JSON 错误:', e);
    }
    return [];
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) process.exit(1);
    }

    await launchChrome();

    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) process.exit(1);

    const context = browser.contexts()[0];
    await context.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });

    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    // --- 作者原汁原味的核心续期逻辑 ---
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
            }

            console.log('正在前往登录页...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            console.log('正在输入凭据...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 15000 });
                await emailInput.fill(user.username);
                
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                await page.getByRole('button', { name: 'Login', exact: true }).click();
                await page.waitForTimeout(3000);

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 账号或密码错误`);
                        const failShotPath = path.join(photoDir, `${safeUsername}_fail.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }
                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录交互错误:', e.message);
                const debugShotPath = path.join(photoDir, `${safeUsername}_login_timeout.png`);
                try {
                    await page.screenshot({ path: debugShotPath, fullPage: true });
                    await sendTelegramMessage(`⚠️ *登录页面加载超时*\n用户: ${user.username}`, debugShotPath);
                } catch (shotErr) { }
                continue;
            }

            console.log('正在寻找 "See" 链接...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('未找到 "See" 按钮。');
                continue;
            }

            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    try { await confirmBtn.waitFor({ state: 'visible', timeout: 3000 }); } catch (e) { }

                    if (await confirmBtn.isVisible()) {
                        await confirmBtn.click();

                        try {
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 5000) {
                                const currentUrl = page.url();
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                const isNotTime = currentUrl.includes('renew-error') || await notTimeLoc.isVisible().catch(() => false);

                                if (isNotTime) {
                                    let dateStr = 'Unknown Date';
                                    try {
                                        if (await notTimeLoc.first().isVisible({ timeout: 1000 })) {
                                            const text = await notTimeLoc.first().innerText();
                                            const match = text.match(/as of\s+([^\(\n\r]+)/i);
                                            if (match) dateStr = match[1].trim();
                                        }
                                    } catch (e) { }

                                    console.log(`   >> ⏳ 暂无法续期: ${dateStr}`);
                                    const skipShotPath = path.join(photoDir, `${safeUsername}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }
                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByRole('button', { name: 'Close' });
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }

                                if (await page.getByText('Please complete the captcha to continue').isVisible().catch(() => false)) {
                                    hasCaptchaError = true;
                                    break;
                                }
                                await page.waitForTimeout(300);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }
                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                } else {
                    break;
                }
            }
        } catch (err) {
            console.error(`处理用户错误:`, err);
        }

        const screenshotPath = path.join(photoDir, `user_${i + 1}.png`);
        try { await page.screenshot({ path: screenshotPath, fullPage: true }); } catch (e) { }
    }

    await browser.close();
    process.exit(0);
})();
