// Explicit opt-in: one tiny real Codex model call using synthetic text only.
import {resolve,join} from 'node:path';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {runCodex} from '../src/codex-runner.mjs';
assert(process.env.WORKTRACE_TEST_CODEX,'Set WORKTRACE_TEST_CODEX to the local codex.exe path for this opt-in integration test.');
const temp=resolve(process.env.TEMP||'.','worktrace-codex-verification');mkdirSync(temp,{recursive:true});const dir=mkdtempSync(join(temp,'run-'));
const schema={type:'object',additionalProperties:false,required:['status','facts','unknown'],properties:{status:{enum:['draft_only']},facts:{type:'array',items:{type:'string'},maxItems:3},unknown:{type:'array',items:{type:'string'},maxItems:3}}};
const {result,usage}=await runCodex({executable:process.env.WORKTRACE_TEST_CODEX,dir,schema,model:process.env.WORKTRACE_TEST_MODEL||'gpt-6.1-sol',reasoningEffort:'high',timeoutSeconds:180,prompt:'只分析下列合成测试，不调用任何工具。仅按 JSON 输出：客户问专利是否授权；员工看到的案件状态是“待答复”，只生成了“我先核对最新记录”的草稿。列出已知事实和仍未知的事实。不能认定已授权或已发送。status 必须 draft_only。'});
assert.equal(result.status,'draft_only');assert(result.facts.length>0&&result.unknown.length>0);const report={passed:true,synthetic_only:true,real_cli:true,model:process.env.WORKTRACE_TEST_MODEL||'gpt-6.1-sol',reasoning_effort:'high',unexpected_tools:false,usage,result};writeFileSync('codex-worker-'+(process.env.WORKTRACE_TEST_MODEL||'gpt-6.1-sol')+'-verification.local.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
