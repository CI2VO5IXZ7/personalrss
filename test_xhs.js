import { readCookies } from './src/store.js';
import { fetchProfile } from './src/crawlers/xhs.js';
import { Miniflare } from 'miniflare';

const mf = new Miniflare({
  modules: true,
  script: `export default { fetch() { return new Response("ok"); } }`,
  kvNamespaces: ["CACHE", "COOKIES"]
});

async function run() {
  const env = {
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
    CF_API_TOKEN: process.env.CF_API_TOKEN,
    COOKIES: await mf.getKVNamespace("COOKIES")
  };
  
  // mock cookie
  await env.COOKIES.put('xhs', JSON.stringify({
    cookies: [{name:"webId", value:"123", domain:".xiaohongshu.com"}],
    savedAt: new Date().toISOString()
  }));

  try {
    const posts = await fetchProfile(env, '6979812a000000002102c464');
    console.log("Found posts:", posts.length);
    if(posts.length > 0) console.log(posts[0]);
  } catch(e) {
    console.error("Error:", e);
  }
}
run();
