export function extensionManifest(base:Record<string,unknown>,images=false){
 const permissions=(base.permissions as string[]).filter(value=>value!=='debugger');
 return{...base,permissions:images?[...permissions,'debugger']:permissions};
}
