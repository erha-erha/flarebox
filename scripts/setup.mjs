#!/usr/bin/env node
// FlareBox 一键部署脚本
//
//   npm run setup                                  # 交互式
//   npm run setup -- --domain mail.example.com     # 绑定自定义域名
//   npm run setup -- --device                      # 在远程服务器 / SSH 上授权 Cloudflare
//
// 做的事：授权 Cloudflare（wrangler login）→ 构建 → 部署（自动创建 D1 数据库）
// → 生成一次性安装码，输出设置管理员密码的链接。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function step(text) {
  console.log(`\n\x1b[38;5;208m▸\x1b[0m \x1b[1m${text}\x1b[0m`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\n✖ 命令失败：${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

/** Runs a command, streaming its output while also capturing it. */
function runCapture(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function ask(question) {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

console.log("\n\x1b[1mFlareBox · 自有域名邮箱 · 一键部署\x1b[0m");

// 1. Cloudflare authorization
step("检查 Cloudflare 授权");
const who = spawnSync(npx, ["wrangler", "whoami"], { encoding: "utf8", shell: process.platform === "win32" });
if (/not authenticated|You are not logged in/i.test(`${who.stdout}${who.stderr}`)) {
  const headless =
    flag("device") ||
    !!process.env.SSH_CONNECTION ||
    (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  console.log(headless ? "将使用设备码授权：在任意设备的浏览器中打开下面的链接并确认即可。" : "浏览器会打开 Cloudflare 授权页，点击「Allow」即可。");
  run(npx, ["wrangler", "login", ...(headless ? ["--device"] : [])]);
} else {
  console.log("已授权。");
}

// 2. Custom domain
let domain = option("domain");
if (domain === undefined && !flag("yes")) {
  domain = await ask("绑定的自定义域名（例如 mail.example.com，该域名需托管在 Cloudflare；留空则使用 workers.dev 地址）：");
}
domain = (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

// 3. Build
step("构建前端与 Worker");
run(npm, ["run", "build"]);

// 4. Deploy (D1 is provisioned automatically) together with a one-time setup code
step("部署到 Cloudflare");
const setupToken = randomBytes(18).toString("base64url");
const secretsFile = join(tmpdir(), `flarebox-secrets-${process.pid}.json`);
writeFileSync(secretsFile, JSON.stringify({ SETUP_TOKEN: setupToken }), { mode: 0o600 });
let result;
try {
  result = await runCapture(npx, [
    "wrangler",
    "deploy",
    "--secrets-file",
    secretsFile,
    ...(domain ? ["--domain", domain] : []),
  ]);
} finally {
  rmSync(secretsFile, { force: true });
}
if (result.code !== 0) {
  console.error("\n✖ 部署失败，请查看上面的错误信息。");
  process.exit(result.code ?? 1);
}

const workersDev = result.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
const base = domain ? `https://${domain}` : workersDev;

step("完成 🎉");
if (base) {
  console.log(`邮箱地址：${base}`);
  console.log(`\n首次使用请打开下面的链接设置管理员密码（链接内含一次性安装码，仅在设置前有效）：`);
  console.log(`\x1b[1m${base}/?setup=${setupToken}\x1b[0m`);
} else {
  console.log("请在上面的输出中找到 Worker 地址，打开后使用以下安装码设置管理员密码：");
  console.log(`\x1b[1m${setupToken}\x1b[0m`);
}
if (domain) console.log("\n自定义域名的证书通常在 1–5 分钟内生效。");
console.log("\n下一步：登录后进入「设置 → 域名」，连接 Cloudflare 并一键接入你的邮箱域名。\n");
