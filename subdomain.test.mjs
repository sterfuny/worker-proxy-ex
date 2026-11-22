// 子域名编解码与注入脚本的本地单元测试
// 运行：node subdomain.test.mjs
import assert from "node:assert/strict";
import worker, {
  encodeHostToLabel, decodeLabelToHost, parseProxyHostname, toProxyUrl,
  restoreProxyUrlsInText, httpRequestInjection, htmlCovPathInject, mainPage, pwdPage,
} from "./_worker.js";

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log("ok - " + name); }

// 1. host 编解码往返
const hosts = [
  "github.com", "www.google.com", "my-site.com", "a--b.example.co.uk",
  "sub.domain.example.com", "example.com:8080", "my-site.com:8443",
  "xn--fiqs8s.cn", "a-b-c-d.example.org", "localhost:3000", "1.2.3.4:9000",
];
for (const h of hosts) {
  ok("roundtrip " + h, () => {
    const label = encodeHostToLabel(h);
    assert.ok(!label.includes("."), "label 必须是单级 DNS label");
    assert.ok(label.length <= 63, "label 超过 DNS 63 字符上限: " + label);
    assert.equal(decodeLabelToHost(label), h);
  });
}

// 2. 子域名解析
ok("parse https", () => assert.deepEqual(parseProxyHostname("github-com-p.xxx.com"), { protocol: "https:", host: "github.com" }));
ok("parse http", () => assert.deepEqual(parseProxyHostname("example-com-ph.xxx.com"), { protocol: "http:", host: "example.com" }));
ok("parse dash host", () => assert.deepEqual(parseProxyHostname("my--site-com-p.xxx.com"), { protocol: "https:", host: "my-site.com" }));
ok("parse port", () => assert.deepEqual(parseProxyHostname("my--site-com---8080-p.xxx.com"), { protocol: "https:", host: "my-site.com:8080" }));
ok("parse host ending .ph", () => assert.deepEqual(parseProxyHostname("example-ph-p.xxx.com"), { protocol: "https:", host: "example.ph" }));
ok("parse host ending .p", () => assert.deepEqual(parseProxyHostname("example-p-p.xxx.com"), { protocol: "https:", host: "example.p" }));
ok("parse non-proxy bare", () => assert.equal(parseProxyHostname("xxx.com"), null));
ok("parse non-proxy multi-label", () => assert.equal(parseProxyHostname("a.b.xxx.com"), null));
ok("parse foreign domain", () => assert.equal(parseProxyHostname("github-com-p.evil.com"), null));
ok("parse no suffix", () => assert.equal(parseProxyHostname("github-com.xxx.com"), null));

// 3. 目标 URL -> 代理 URL
ok("toProxyUrl https", () => assert.equal(toProxyUrl("https://github.com/a?b=1#c", "https:"), "https://github-com-p.xxx.com/a?b=1#c"));
ok("toProxyUrl http", () => assert.equal(toProxyUrl("http://example.com/x", "https:"), "https://example-com-ph.xxx.com/x"));
ok("toProxyUrl port", () => assert.equal(toProxyUrl("https://my-site.com:8443/", "https:"), "https://my--site-com---8443-p.xxx.com/"));
ok("toProxyUrl already proxied", () => assert.equal(toProxyUrl("https://github-com-p.xxx.com/a", "https:"), "https://github-com-p.xxx.com/a"));

// 4. Header/Body 还原
ok("restore referer", () => assert.equal(
  restoreProxyUrlsInText("https://github-com-p.xxx.com/foo/bar"),
  "https://github.com/foo/bar".replace("/foo/bar", "") + "/foo/bar"));
ok("restore mixed text", () => assert.equal(
  restoreProxyUrlsInText('{"a":"https://github-com-p.xxx.com","b":"http://example-com-ph.xxx.com","c":"https://untouched.com"}'),
  '{"a":"https://github.com","b":"http://example.com","c":"https://untouched.com"}'));

// 5. 注入脚本语法可解析
ok("httpRequestInjection syntax", () => { new Function(httpRequestInjection); });
ok("htmlCovPathInject syntax", () => { new Function("covToAbs", "removeIntegrityAttributesFromElement", "makeProxyUrl", htmlCovPathInject); });
for (const [name, page] of [["mainPage", mainPage], ["pwdPage", pwdPage]]) {
  ok(name + " inline script syntax", () => {
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    for (const s of scripts) new Function(s[1]);
  });
}

// 6. 客户端与服务端编码一致性：截取注入脚本中的纯函数部分，在 stub window 下执行
ok("client/server encode consistency", () => {
  const cut = httpRequestInjection.indexOf("// 每次都要动态计算");
  const pureFns = httpRequestInjection.substring(0, cut);
  const stubWindow = { location: { host: "github-com-p.xxx.com", hostname: "github-com-p.xxx.com", protocol: "https:" } };
  const factory = new Function("window", pureFns + "; return { encodeHostToLabel, decodeLabelToHost, parseProxyLabel, makeProxyUrl };");
  const client = factory(stubWindow);
  for (const h of hosts) {
    assert.equal(client.encodeHostToLabel(h), encodeHostToLabel(h));
    assert.equal(client.decodeLabelToHost(encodeHostToLabel(h)), h);
  }
  assert.deepEqual(client.parseProxyLabel("github-com-p"), { protocol: "https:", host: "github.com" });
  assert.equal(client.makeProxyUrl("https://duckduckgo.com/?q=hi"), "https://duckduckgo-com-p.xxx.com/?q=hi");
  assert.equal(client.makeProxyUrl("https://github-com-p.xxx.com/a"), "https://github-com-p.xxx.com/a");
});

// 7. 入口冒烟测试（不触发对外 fetch 的分支）
{
  const res1 = await worker.fetch(new Request("https://github-com-p.xxx.com/"));
  const body1 = await res1.text();
  assert.ok(body1.includes('id="password"'), "未带密码 Cookie 应返回密码页");
  passed++; console.log("ok - no password -> password page");

  const authed = { headers: { Cookie: "__PROXY_PWD__=009178" } };
  const res2 = await worker.fetch(new Request("https://xxx.com/", authed));
  const body2 = await res2.text();
  assert.ok(body2.includes("urlForm"), "裸域首页应返回引导页");
  passed++; console.log("ok - bare domain -> main page");

  const res3 = await worker.fetch(new Request("https://xxx.com/https://github.com/a?b=1", authed));
  assert.equal(res3.status, 301);
  assert.equal(res3.headers.get("Location"), "https://github-com-p.xxx.com/a?b=1");
  passed++; console.log("ok - legacy path -> subdomain redirect");

  const res4 = await worker.fetch(new Request("https://xxx.com/robots.txt", authed));
  assert.ok((await res4.text()).includes("Disallow"));
  passed++; console.log("ok - robots.txt");
}

console.log("\nAll " + passed + " tests passed.");