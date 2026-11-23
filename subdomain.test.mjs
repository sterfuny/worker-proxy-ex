// 子域名编解码与注入脚本的本地单元测试
// 运行：node subdomain.test.mjs
import assert from "node:assert/strict";
import worker, {
  proxyBaseDomain as D, proxySuffixHttps as S, proxySuffixHttp as SH, password,
  encodeHostToLabel, decodeLabelToHost, parseProxyHostname, toProxyUrl,
  restoreProxyUrlsInText, httpRequestInjection, htmlCovPathInject, mainPage, pwdPage,
} from "./_worker.js";

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log("ok - " + name); }

// 生成期望的代理子域名 host，例如 github-com-p.linelinkd.dpdns.org
const ph = (targetHost, http = false) =>
  `${encodeHostToLabel(targetHost)}${http ? SH : S}.${D}`;
const host = (label) => `${label}.${D}`;

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
ok("parse https", () => assert.deepEqual(parseProxyHostname(ph("github.com")), { protocol: "https:", host: "github.com" }));
ok("parse http", () => assert.deepEqual(parseProxyHostname(ph("example.com", true)), { protocol: "http:", host: "example.com" }));
ok("parse dash host", () => assert.deepEqual(parseProxyHostname(ph("my-site.com")), { protocol: "https:", host: "my-site.com" }));
ok("parse port", () => assert.deepEqual(parseProxyHostname(ph("my-site.com:8080")), { protocol: "https:", host: "my-site.com:8080" }));
ok("parse host ending with http suffix", () => assert.deepEqual(parseProxyHostname(ph("example.hp", true)), { protocol: "http:", host: "example.hp" }));
ok("parse host ending .hp as https", () => assert.deepEqual(parseProxyHostname(ph("example.hp")), { protocol: "https:", host: "example.hp" }));
ok("parse host ending .p as https", () => assert.deepEqual(parseProxyHostname(ph("example.p")), { protocol: "https:", host: "example.p" }));
ok("parse non-proxy bare", () => assert.equal(parseProxyHostname(D), null));
ok("parse non-proxy multi-label", () => assert.equal(parseProxyHostname(`a.b.${D}`), null));
ok("parse worker hostname", () => assert.equal(parseProxyHostname(`p.${D}`), null));
ok("parse foreign domain", () => assert.equal(parseProxyHostname(`github-com${S}.evil.com`), null));
ok("parse no suffix", () => assert.equal(parseProxyHostname(host(encodeHostToLabel("github.com"))), null));

// 3. 目标 URL -> 代理 URL
ok("toProxyUrl https", () => assert.equal(toProxyUrl("https://github.com/a?b=1#c", "https:"), `https://${ph("github.com")}/a?b=1#c`));
ok("toProxyUrl http", () => assert.equal(toProxyUrl("http://example.com/x", "https:"), `https://${ph("example.com", true)}/x`));
ok("toProxyUrl port", () => assert.equal(toProxyUrl("https://my-site.com:8443/", "https:"), `https://${ph("my-site.com:8443")}/`));
ok("toProxyUrl already proxied", () => assert.equal(toProxyUrl(`https://${ph("github.com")}/a`, "https:"), `https://${ph("github.com")}/a`));

// 4. Header/Body 还原
ok("restore referer", () => assert.equal(
  restoreProxyUrlsInText(`https://${ph("github.com")}/foo/bar`),
  "https://github.com/foo/bar"));
ok("restore mixed text", () => assert.equal(
  restoreProxyUrlsInText(`{"a":"https://${ph("github.com")}","b":"http://${ph("example.com", true)}","c":"https://untouched.com"}`),
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
  const stub = { location: { host: ph("github.com"), hostname: ph("github.com"), protocol: "https:" } };
  const factory = new Function("window", pureFns + "; return { encodeHostToLabel, decodeLabelToHost, parseProxyLabel, makeProxyUrl };");
  const client = factory(stub);
  for (const h of hosts) {
    assert.equal(client.encodeHostToLabel(h), encodeHostToLabel(h));
    assert.equal(client.decodeLabelToHost(encodeHostToLabel(h)), h);
  }
  assert.deepEqual(client.parseProxyLabel(encodeHostToLabel("github.com") + S), { protocol: "https:", host: "github.com" });
  assert.equal(client.makeProxyUrl("https://duckduckgo.com/?q=hi"), `https://${ph("duckduckgo.com")}/?q=hi`);
  assert.equal(client.makeProxyUrl(`https://${ph("github.com")}/a`), `https://${ph("github.com")}/a`);
});

// 7. 入口冒烟测试（不触发对外 fetch 的分支）
{
  const res1 = await worker.fetch(new Request(`https://${ph("github.com")}/`));
  const body1 = await res1.text();
  assert.ok(body1.includes('id="password"'), "未带密码 Cookie 应返回密码页");
  passed++; console.log("ok - no password -> password page");

  const authed = { headers: { Cookie: "__PROXY_PWD__=" + password } };
  const res2 = await worker.fetch(new Request(`https://p.${D}/`, authed));
  const body2 = await res2.text();
  assert.ok(body2.includes("urlForm"), "worker hostname 首页应返回引导页");
  passed++; console.log("ok - worker hostname -> main page");

  const res3 = await worker.fetch(new Request(`https://p.${D}/https://github.com/a?b=1`, authed));
  assert.equal(res3.status, 301);
  assert.equal(res3.headers.get("Location"), `https://${ph("github.com")}/a?b=1`);
  passed++; console.log("ok - legacy path -> subdomain redirect");

  const res4 = await worker.fetch(new Request(`https://p.${D}/robots.txt`, authed));
  assert.ok((await res4.text()).includes("Disallow"));
  passed++; console.log("ok - robots.txt");
}

console.log("\nAll " + passed + " tests passed.");