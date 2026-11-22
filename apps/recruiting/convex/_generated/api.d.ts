/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as companies from "../companies.js";
import type * as demo from "../demo.js";
import type * as hiring from "../hiring.js";
import type * as intelligence from "../intelligence.js";
import type * as introductions from "../introductions.js";
import type * as liveData from "../liveData.js";
import type * as market from "../market.js";
import type * as matching from "../matching.js";
import type * as materials from "../materials.js";
import type * as profiles from "../profiles.js";
import type * as provider_crustdata from "../provider/crustdata.js";
import type * as provider_models from "../provider/models.js";
import type * as system from "../system.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  companies: typeof companies;
  demo: typeof demo;
  hiring: typeof hiring;
  intelligence: typeof intelligence;
  introductions: typeof introductions;
  liveData: typeof liveData;
  market: typeof market;
  matching: typeof matching;
  materials: typeof materials;
  profiles: typeof profiles;
  "provider/crustdata": typeof provider_crustdata;
  "provider/models": typeof provider_models;
  system: typeof system;
  uploads: typeof uploads;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
