export type AssigneePerson = string | {id:string;name:string};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const personId=(person:AssigneePerson)=>typeof person==='string'?person:person.id;
export const personName=(person:AssigneePerson)=>typeof person==='string'?person:person.name;
export function resolveAssignee(value:string,people:AssigneePerson[]){
 const exact=people.find(person=>personId(person)===value);
 if(exact)return {id:personId(exact),name:uuid.test(personName(exact))?'Unknown reviewer':personName(exact)};
 const matches=people.filter(person=>personName(person)===value);
 if(matches.length===1)return {id:personId(matches[0]),name:personName(matches[0])};
 return {id:value,name:uuid.test(value)?'Unknown reviewer':value};
}
export function displayedAssignees(values:string[],people:AssigneePerson[]){
 const seen=new Set<string>();return values.map(value=>resolveAssignee(value,people)).filter(person=>{if(seen.has(person.id))return false;seen.add(person.id);return true;});
}
export const assigneeChecked=(values:string[],person:AssigneePerson,people:AssigneePerson[])=>displayedAssignees(values,people).some(value=>value.id===personId(person));
export function toggleAssignee(values:string[],person:AssigneePerson,people:AssigneePerson[]){
 const id=personId(person),selected=assigneeChecked(values,person,people);
 const normalized=displayedAssignees(values,people).map(value=>value.id);
 return selected?normalized.filter(value=>value!==id):[...normalized,id];
}
