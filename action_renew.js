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

        // 延长等待时间到 3 秒，确保 Xray 完全建立建连
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

    console.log('[代理] 正在验证代理连接 (尝试连接 https://www.google.com)...');
    try {
        const proxyUrl = new URL(PROXY_CONFIG.server);
        const axiosConfig = {
            proxy: {
                protocol: proxyUrl.protocol.replace(':', ''),
                host: proxyUrl.hostname,
                port: proxyUrl.port,
            },
            timeout: 15000 // 15秒超时
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
        console.error(`[代理] 验证失败，详细错误原因: ${error.message}`);
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
            console.error('[代理] 代理格式错误，解析失败');
            process.exit(1);
        }
    }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

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
        '--disable-extensions'
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
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
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
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);

                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1
                });

                console.log('>> CDP 点击已发送。');
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
                await page.waitForTimeout(2000);
            }

            console.log('正在打开登录页面...');
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3000);

            // 检查并尝试清理 Cloudflare / Turnstile 验证屏
            console.log('   >> 检查页面是否触发了 Cloudflare 验证屏...');
            for (let checkSec = 0; checkSec < 10; checkSec++) {
                const cdpOk = await attemptTurnstileCdp(page);
                if (cdpOk) {
                    console.log('   >> 尝试通过 CDP 点击 Cloudflare 验证框...');
                    await page.waitForTimeout(3000);
                } else {
                    await page.waitForTimeout(1000);
                }
            }

            console.log('正在输入凭据...');
            try {
                const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="Email"], #email').first();
                await emailInput.waitFor({ state: 'visible', timeout: 15000 });
                await emailInput.fill(user.username);

                const pwdInput = page.locator('input[type="password"], input[name="password"]').first();
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                let cdpClickResult = false;
                for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                    cdpClickResult = await attemptTurnstileCdp(page);
                    if (cdpClickResult) break;
                    await page.waitForTimeout(1000);
                }

                if (cdpClickResult) {
                    console.log('   >> 登录 CDP 点击生效。正在等待最多 10秒 Cloudflare 成功标志...');
                    for (let waitSec = 0; waitSec < 10; waitSec++) {
                        const frames = page.frames();
                        let isSuccess = false;
                        for (const f of frames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 500 })) {
                                        isSuccess = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (isSuccess) {
                            console.log('   >> 登录前 Turnstile 验证成功。');
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                } else {
                    console.log('   >> 登录前未检测到或未点击 Turnstile，继续操作...');
                }

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ 登录失败: 用户 ${user.username} 账号或密码错误`);
                        const failShotPath = path.join(photoDir, `${safeUsername}_fail.png`);
                        try { await page.screenshot({ path: failShotPath, fullPage: true }); } catch (e) { }

                        await sendTelegramMessage(`❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                console.log('登录输入框未找到/登录错误:', e.message);

                const debugShotPath = path.join(photoDir, `${safeUsername}_login_timeout.png`);
                try {
                    await page.screenshot({ path: debugShotPath, fullPage: true });
                    console.log(`[调试] 已保存加载失败时的页面截图至: ${debugShotPath}`);
                    await sendTelegramMessage(`⚠️ *登录页面加载超时*\n用户: ${user.username}\n原因: 未能定位到登录框，请查看截图`, debugShotPath);
                } catch (shotErr) {
                    console.log('截图失败:', shotErr.message);
                }
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
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    try {
                        await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e) { }

                    if (await confirmBtn.isVisible()) {
                        console.log('   >> 直接点击模态框中的 Renew 确认按钮...');
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

                                    if (dateStr === 'Unknown Date' && currentUrl.includes('renew-error')) {
                                        try {
                                            const rawUrlText = currentUrl.replace(/\+/g, ' ');
                                            const decodedUrl = decodeURIComponent(rawUrlText);
                                            const matchUrl = decodedUrl.match(/as of\s+([^\(\n\r&]+)/i);
                                            if (matchUrl) dateStr = matchUrl[1].trim();
                                        } catch (e) { }
                                    }

                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    const skipShotPath = path.join(photoDir, `${safeUsername}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true }); } catch (e) { }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true;
                                    try {
                                        const closeBtn = modal.getByRole('button', { name: 'Close' });
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }

                                if (await page.getByText('Please complete the captcha to continue').isVisible().catch(() => false)) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha". 需要进行 Turnstile 验证.');
                                    hasCaptchaError = true;
                                    break;
                                }

                                await page.waitForTimeout(300);
                            }
                        } catch (e) { }

                        if (renewSuccess) break;

                        if (hasCaptchaError) {
                            console.log('   >> 尝试通过 Turnstile CDP 绕过验证码...');
                            for (let findAttempt = 0; findAttempt < 10; findAttempt++) {
                                const ok = await attemptTurnstileCdp(page);
                                if (ok) {
                                    await page.waitForTimeout(3000);
                                    await confirmBtn.click();
                                    break;
                                }
                                await page.waitForTimeout(1000);
                            }
                            console.log('   >> 刷新页面重试...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }

                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true }); } catch (e) { }

                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    break;
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        const screenshotPath = path.join(photoDir, `user_${i + 1}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
