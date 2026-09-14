import {SkinViewer} from 'skinview3d';
let viewer=null,enabled=false;
window.licarisSkin={
 async show(url,model){
  try{
   viewer??=new SkinViewer({canvas:document.getElementById('skin-canvas'),width:300,height:370,alpha:true});
   viewer.autoRotate=!matchMedia('(prefers-reduced-motion: reduce)').matches;viewer.zoom=.85;
   await viewer.loadSkin(url,{model:model==='slim'?'slim':'default'});viewer.renderPaused=!enabled;
   document.getElementById('skin-canvas').hidden=false;document.getElementById('skin-fallback').hidden=true;
  }catch{
   document.getElementById('skin-canvas').hidden=true;const canvas=document.getElementById('skin-fallback');canvas.hidden=false;
   const img=new Image();img.src=url;await img.decode();const c=canvas.getContext('2d');c.imageSmoothingEnabled=false;c.clearRect(0,0,128,256);
   c.drawImage(img,8,8,8,8,32,0,64,64);c.drawImage(img,40,8,8,8,32,0,64,64);c.drawImage(img,20,20,8,12,32,64,64,96);
   c.drawImage(img,44,20,4,12,0,64,32,96);c.drawImage(img,img.height===64?36:44,img.height===64?52:20,4,12,96,64,32,96);
   c.drawImage(img,4,20,4,12,32,160,32,96);c.drawImage(img,img.height===64?20:4,img.height===64?52:20,4,12,64,160,32,96);
  }
 },
 visible(value){enabled=value;if(viewer)viewer.renderPaused=!value;},
 rotate(){if(!viewer)return false;viewer.autoRotate=!viewer.autoRotate;return viewer.autoRotate;},
 clear(){if(viewer){viewer.loadSkin(null);viewer.renderPaused=true;}document.getElementById('skin-fallback').hidden=true;}
};
