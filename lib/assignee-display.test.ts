import test from 'node:test';
import assert from 'node:assert/strict';
import {displayedAssignees,assigneeChecked,toggleAssignee,resolveAssignee} from './assignee-display';
test('assignee avatars labels and checkboxes share ID-first mixed-name resolution',()=>{
 const people=[{id:'a',name:'Kevin'},{id:'b',name:'Wangyu'},{id:'c',name:'why'}];
 const values=['a','Kevin','Wangyu','c'];
 assert.deepEqual(displayedAssignees(values,people),people);
 for(const person of people)assert.equal(assigneeChecked(values,person,people),true);
 assert.deepEqual(toggleAssignee(values,people[0],people),['b','c']);
 assert.equal(resolveAssignee('569b807f-73c4-4ba2-9623-818be3e97523',people).name,'Unknown reviewer');
 assert.equal(resolveAssignee('Kevin',[{id:'Kevin',name:'Actual ID'},{id:'other',name:'Kevin'}]).name,'Actual ID');
 assert.equal(resolveAssignee('Old Name',people).name,'Old Name');
});
