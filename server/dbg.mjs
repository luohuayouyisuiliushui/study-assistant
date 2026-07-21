import { Provider } from './engine/provider.js';
import { recommendResources } from './engine/learn-engine.js';
import * as store from './engine/learn-store.js';
function mp(content){ const c={chat:{completions:{async create(){return{choices:[{message:{content,role:'assistant'}}],model:'m',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};}}}}; const p=new Provider({apiKey:'k',baseURL:'https://x/v1',model:'m'}); p._client=c; p._autoWarm=false; return p; }
const plan = await store.createPlan('dbg');
await store.addTopics(plan.id, ['T']);
const tid = store.getPlan(plan.id).topics[0].id;
const r1 = await recommendResources(mp(JSON.stringify({topicTitle:'X',resources:[{title:'a'}]})), store.getPlan(plan.id), tid, 'm');
console.log('r1 len', r1.resources.length, JSON.stringify(r1.resources));
await store.deletePlan(plan.id);
