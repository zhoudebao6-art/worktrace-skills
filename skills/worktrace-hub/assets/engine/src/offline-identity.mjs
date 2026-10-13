import {hostname} from 'node:os';
import {assert,id,keys,str,uuid,hash} from './protocol.mjs';
export function createOfflineIdentity(p){
 keys(p,['format','org_id','org_name','employee_id','employee_name','label'],['format','org_name','employee_id','employee_name','label']);
 assert(p.format==='worktrace.offline-identity/1.0','离线身份格式无效');
 assert(p.org_id===undefined||id(p.org_id),'公司编号必须为 UUID');
 assert(str(p.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(p.employee_id),'员工编号无效');
 for(const k of ['org_name','employee_name','label'])assert(str(p[k],100)&&p[k].trim(),'身份字段不能为空：'+k);
 const org_id=p.org_id||uuid();return {role:'collector',connection_mode:'offline',org_id,org_name:p.org_name.trim(),employee_id:p.employee_id,employee_name:p.employee_name.trim(),label:p.label.trim(),device_id:uuid(),installation_id:uuid(),host_binding:hash(org_id+':'+hostname())};
}
export function validateAdoptionIdentity(p){
 assert(p&&id(p.org_id)&&id(p.device_id)&&id(p.installation_id)&&id(p.stream_id),'接纳身份缺少原始编号');
 assert(str(p.employee_id,80)&&/^[\p{L}\p{N}_.-]+$/u.test(p.employee_id),'接纳员工编号无效');for(const k of ['org_name','employee_name','label'])assert(str(p[k],100)&&p[k].trim(),'接纳身份字段无效');return p;
}
export function adoptOfflineDevice(store,config,identity){
 validateAdoptionIdentity(identity);assert(config.role==='hub'&&config.org_id===identity.org_id,'目标总控公司编号不同；禁止静默合并或重写来源编号');const old=store.device(identity.device_id);
 if(old)assert(old.org_id===identity.org_id&&old.employee_id===identity.employee_id&&old.employee_name===identity.employee_name&&old.label===identity.label&&!old.revoked&&(!old.installation_id||old.installation_id===identity.installation_id),'设备登记冲突或已撤销');
 store.db.exec('SAVEPOINT offline_device_adoption');try{if(!old)store.addDevice(identity);store.db.prepare('UPDATE devices SET installation_id=? WHERE device_id=?').run(identity.installation_id,identity.device_id);store.audit('offline.device.adopt',identity.device_id);store.db.exec('RELEASE SAVEPOINT offline_device_adoption');}catch(error){store.db.exec('ROLLBACK TO SAVEPOINT offline_device_adoption');store.db.exec('RELEASE SAVEPOINT offline_device_adoption');throw error;}
 return {adopted:!old,already_registered:!!old,device_id:identity.device_id,network_enrollment:false};
}
