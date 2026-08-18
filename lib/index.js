/**
 * dsh-aseprite host half.
 *
 * The editor itself is 100% client-side (pixel canvas, layers/frames/palette,
 * Aseprite .aseprite read/write in the browser). This entry only satisfies the
 * loader row referenced by cordis.patch.yml, so the package's dsh.client
 * declaration is scanned and /plugins/dsh-aseprite/client.js is served.
 */
export const name = 'dsh-aseprite'

export function apply(ctx) {
  if (ctx.logger?.debug) {
    ctx.logger.debug('dsh-aseprite: host half loaded (client bundle served at /plugins/dsh-aseprite/client.js)')
  }
}
