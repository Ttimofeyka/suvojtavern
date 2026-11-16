/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createModelsGateway } from "./gateway-models";
import type { GatewayDeps } from "./gateway-shared";
import { createStreamGateway } from "./gateway-stream";

// The endpoint surface is re-exported here so routes and the tracker resolve
// upstreams from one import site (they already build the gateway from `./gateway`).
export type { Endpoint, GatewayDeps, GatewayModel } from "./gateway-shared";
export { GatewayError, gatewayStatus, resolveEndpoint } from "./gateway-shared";
export type { ChatCompletionOpts } from "./gateway-stream";

export function createGateway(deps: GatewayDeps) {
  const models = createModelsGateway(deps);
  const stream = createStreamGateway(deps);
  return {
    getModels: models.getModels,
    chatCompletion: stream.chatCompletion,
  };
}
