declare module "select2/dist/js/select2.js" {
  import type { JQueryStatic } from "jquery";

  const select2Factory: (root: Window, jquery: JQueryStatic) => JQueryStatic;
  export default select2Factory;
}
