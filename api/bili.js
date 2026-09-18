// ============================================================
// B站 API 中转代理（Vercel Serverless Function）v2 — CommonJS
// 用途：Cloudflare（东京 IP 段被风控）/ Deno（注册受限）时的备选。
//       Vercel 免费版函数运行在 AWS，出口 IP 与 Cloudflare 不同。
//
// 部署：
//   1. 把本文件夹（vercel-bili-proxy/）推送到 GitHub 仓库
//   2. vercel.com → New Project → 导入该仓库 → Deploy
//   3. 得到 https://<项目名>.vercel.app
//   4. 后台「B站中转地址」填 https://<项目名>.vercel.app/api/bili
//
// 访问方式：
//   https://<项目名>.vercel.app/api/bili/x/web-interface/view?bvid=...
// ============================================================

const TARGET_HOST = "api.bilibili.com";

function randomBuvid3() {
  const chars = "0123456789ABCDEF";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s + "infoc";
}

module.exports = async function handler(req, res) {
  // 只处理 /api/bili/* 路径
  const originalUrl = new URL(req.url, "https://" + (req.headers.host || "localhost"));
  const prefix = "/api/bili";
  if (!originalUrl.pathname.startsWith(prefix)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "use /api/bili/x/web-interface/view?bvid=..." }));
    return;
  }

  // 构造转发目标：去掉 /api/bili 前缀，其余路径/查询参数保留，换 Host
  const targetPath = originalUrl.pathname.slice(prefix.length) || "/";
  const target = new URL(targetPath + originalUrl.search, "https://" + TARGET_HOST);
  target.protocol = "https:";
  target.host = TARGET_HOST;

  // 请求头处理
  const headers = {};
  for (const k of Object.keys(req.headers || {})) {
    const lk = k.toLowerCase();
    // 过滤掉 Host/Content-Length/Connection，以及 Origin：
    // ⚠️ 经实测，带 Origin 头的请求经 Vercel 转发后会被 B 站风控拦截
    //   （Origin=https://www.bilibili.com 但实际来自 Vercel 转发链路 → CSRF/风控判定）。
    //   同时过滤 user-agent / sec-ch-ua*：统一由下方覆盖为配套的浏览器指纹，
    //   避免客户端（后端）只带 UA 而缺 sec-ch-ua 系列头 → B 站判定伪造 UA → 412。
    if (["host", "content-length", "connection", "origin", "user-agent",
         "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"].includes(lk)) continue;
    headers[k] = req.headers[k];
  }
  // 改写关键头
  headers["Host"] = TARGET_HOST;
  headers["Referer"] = "https://www.bilibili.com/";
  // ⚠️ 始终覆盖 UA + sec-ch-ua 系列（不信任客户端传入）：
  //   实测「只带 UA、缺 sec-ch-ua」经 Vercel 转发会被 B 站 412 风控；
  //   「不带 UA、由本脚本补全套」返回 200。因此这里强制统一为配套指纹。
  headers["User-Agent"] =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  headers["sec-ch-ua"] = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"';
  headers["sec-ch-ua-mobile"] = "?0";
  headers["sec-ch-ua-platform"] = '"Windows"';
  headers["Sec-Fetch-Dest"] = "empty";
  headers["Sec-Fetch-Mode"] = "cors";
  headers["Sec-Fetch-Site"] = "same-site";
  delete headers["accept-encoding"];

  // Cookie 处理：透传已有；无则补 buvid3
  const cookieHeader = req.headers.cookie || "";
  headers["Cookie"] = cookieHeader || ("buvid3=" + randomBuvid3());

  try {
    const resp = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "follow",
    });
    const body = Buffer.from(await resp.arrayBuffer());
    res.statusCode = resp.status;
    resp.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (["content-encoding", "transfer-encoding", "connection", "content-length"].includes(lk)) return;
      res.setHeader(k, v);
    });
    res.setHeader("X-Bili-Proxy", "vercel");
    res.setHeader("Content-Length", String(body.length));
    res.end(body);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: String(err) }));
  }
};