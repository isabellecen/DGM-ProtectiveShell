import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./script/ts-loader.mjs", pathToFileURL("./"));
