async (page) => {
  // Start on any hosted PCF from the temporary acceptance fixture.
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.locator('header.pahub-unified').waitFor();
  const measurements=[];
  for (const width of [1440,1920]) for (const theme of ['light','dark']) {
    await page.setViewportSize({width,height:width===1440?900:1080});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    await page.waitForTimeout(100);
    const metrics=await page.evaluate(()=>{
      const banner=document.querySelector('header.banner'),toolbar=document.querySelector('.pahub-toolbar');
      const b=banner.getBoundingClientRect(),t=toolbar.getBoundingClientRect();
      const buttons=[...toolbar.querySelectorAll('.toolbar-group > button,.banner-menu > button')].map(el=>{const r=el.getBoundingClientRect(),c=getComputedStyle(el);return{id:el.id,x:r.x,y:r.y,width:r.width,height:r.height,bg:c.backgroundColor};});
      const overlaps=[];for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i],c=buttons[j];if(a.x+a.width>c.x+.5&&c.x+c.width>a.x+.5&&a.y+a.height>c.y+.5&&c.y+c.height>a.y+.5)overlaps.push([a.id,c.id]);}
      const brand=banner.querySelector('.brand').getBoundingClientRect(),state=banner.querySelector('.banner-actions').getBoundingClientRect();
      return{height:b.height,centerOffset:Math.abs(t.x+t.width/2-(b.x+b.width/2)),buttons,overlaps,brandOverlap:brand.right>t.left+1,statusOverlap:t.right>state.left+1,overflow:document.documentElement.scrollWidth>innerWidth,logo:banner.querySelector('.logo').getBoundingClientRect().height};
    });
    if(metrics.height>81||metrics.centerOffset>2||metrics.overlaps.length||metrics.brandOverlap||metrics.statusOverlap||metrics.overflow||metrics.logo!==32||metrics.buttons.some(b=>Math.abs(b.height-32)>1))throw Error(JSON.stringify({width,theme,metrics}));
    await page.screenshot({path:'output/playwright/banner-unified-'+theme+'-'+width+'.png'});
    measurements.push({width,theme,...metrics});
    if(width===1440)for(const key of ['save','json','excel']){
      const trigger=page.locator('#'+key+'-menu-btn');await trigger.focus();await trigger.press('ArrowDown');
      const panel=page.locator('#'+key+'-menu-panel');await panel.waitFor({state:'visible'});
      const p=await panel.boundingBox(),r=await trigger.boundingBox();
      if(p.y<r.y+r.height||p.x<0||p.x+p.width>width)throw Error(key+' dropdown is misplaced');
      await page.screenshot({path:'output/playwright/banner-unified-menu-'+key+'-'+theme+'.png'});
      await page.keyboard.press('Escape');
    }
  }
  for(const width of [1280,1024,768,375]){await page.setViewportSize({width,height:900});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Narrow overflow at '+width);}
  await page.setViewportSize({width:1440,height:900});
  if(errors.length)throw Error(JSON.stringify(errors));
  return{measurements,narrowWidths:[1280,1024,768,375],pageerrors:errors};
}
