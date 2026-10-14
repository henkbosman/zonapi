/** Beschrijft de werkelijke Growatt TCP-listener; input: runtime met server/laatste fout en Growatt-config; output: adres, luisterstatus en eventuele fout. */
export function growattListenerStatus(runtime, config) {
  const server = runtime?.server;
  const address = server?.listening ? server.address() : null;
  return {
    host: config.host,
    port: config.port,
    listening: server ? server.listening : null,
    bound_host: typeof address === 'object' && address ? address.address : null,
    bound_port: typeof address === 'object' && address ? address.port : null,
    last_error: runtime?.last_error ?? null
  };
}
