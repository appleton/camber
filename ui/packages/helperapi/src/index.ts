export * from "./gen/api";
export { camberAcpPoolsideRenameSession as camberAcpRenameSession } from "./gen/api";
export * from "./manualApi";
import { runtime } from "./orval/clientHelpers";

/**
 * initializeStatefulModule readies the generated helper API methods for use, e.g. `camberHello`
 */
export const initializeStatefulModule = runtime.setImplementation;
