import test from 'node:test';
import assert from 'node:assert/strict';
import { actorExport, spreadsheetCell } from './auditActors.ts';
test('kjx exports neutralize spreadsheet formulas and flatten embedded cell separators',()=>{
 for(const value of ['=1+1','+SUM(A1)','-2+1','@cmd','  =1','\t+1','\r\n @cmd'])assert.ok(spreadsheetCell(value).startsWith("'"));
 assert.equal(spreadsheetCell('Text\twith\r\nlines'),'Text with  lines');
 const row={actorId:'id',actorName:'\t=HYPERLINK("bad")',detail:' @SUM(1)\nnext',drawing:'-formula'};
 for(const csv of [true,false]){
  const result=actorExport(['Detail','Drawing'],[row],value=>[value.detail,value.drawing],csv);
  assert.match(result,/' @SUM\(1\) next/);assert.match(result,/'-formula/);assert.match(result,/' =HYPERLINK/);
  assert.equal(result.split('\n').length,2);
 }
});
