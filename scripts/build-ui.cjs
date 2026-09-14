require('esbuild').buildSync({entryPoints:['ui/skin-viewer-entry.js'],bundle:true,platform:'browser',format:'iife',target:'chrome140',outfile:'ui/skin-viewer.js',minify:true,legalComments:'eof'});
