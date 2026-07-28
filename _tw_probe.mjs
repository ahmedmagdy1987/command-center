import postcss from 'postcss';
import tailwind from 'tailwindcss';
import fs from 'fs';
const css = "@tailwind utilities;";
const r = await postcss([tailwind({config:'./tailwind.config.js'})]).process(css,{from:undefined});
fs.writeFileSync('./_tw_out.css', r.css);
console.log('len', r.css.length);
