const fs = require('fs');
const { WebAssembly } = global;
const pub = '/opt/data/xmr-webminer/repo/public';
const dsMod = new WebAssembly.Module(fs.readFileSync(pub + '/dataset.wasm'));
console.log('dataset imports:', JSON.stringify(WebAssembly.Module.imports(dsMod)));
console.log('dataset exports:', JSON.stringify(WebAssembly.Module.exports(dsMod)));
const vmMod = new WebAssembly.Module(fs.readFileSync(pub + '/vm.wasm'));
console.log('vm imports:', JSON.stringify(WebAssembly.Module.imports(vmMod)));
console.log('vm exports:', JSON.stringify(WebAssembly.Module.exports(vmMod)));