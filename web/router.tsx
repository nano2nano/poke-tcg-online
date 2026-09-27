import { createRouter } from "@tanstack/react-router";
import { BASEPATH } from "./basepath.js";
import { routeTree } from "./routeTree.gen.js";

export function getRouter() {
  return createRouter({ routeTree, basepath: BASEPATH });
}
