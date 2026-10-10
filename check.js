// Basit tutarlılık kontrolü: index.html içindeki id'ler app.js'te geçiyor mu?
const fs = require('fs');
const h = fs.readFileSync('parsel360/index.html', 'utf8');
const js = fs.readFileSync('parsel360/app.js', 'utf8');
const ids = [...h.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const missing = ids.filter(i => !js.includes("'" + i + "'") && !js.includes('"' + i + '"'));
const acts = [...h.matchAll(/data-act="([^"]+)"/g)].map(m => m[1]);
const missingActs = [...new Set(acts)].filter(a => !js.includes("'" + a + "'"));
console.log('HTML id sayısı:', ids.length);
console.log("JS'te geçmeyen id'ler:", missing.length ? missing.join(', ') : '(yok)');
console.log('Veri eylemleri:', [...new Set(acts)].join(', '));
console.log('JS karşılığı olmayan eylem:', missingActs.length ? missingActs.join(', ') : '(yok)');