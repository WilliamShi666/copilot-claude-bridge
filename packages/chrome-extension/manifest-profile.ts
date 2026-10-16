export function extensionManifest(base:Record<string,unknown>,images=false){
 const permissions=(base.permissions as string[]).filter(value=>value!=='debugger');
 return{...base,...(images?{minimum_chrome_version:'125'}:{}),permissions:images?[...permissions,'debugger']:permissions};
}
