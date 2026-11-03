/** dsh-obsidian Client half: mounts the knowledge RPC remote and registers
 *  the Knowledge main panel, its sidebar entry, and the Plugins-page settings
 *  card. Joins the same two-registration pattern the native sidebar uses:
 *  `sidebar.panellist` (list, id `knowledge`) selects the panel while `main`
 *  (keyed, key `knowledge`) hosts its content.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TYPERT_REMOTE, knowledgeRpcOf } from './remote.ts'
import { dictionaries, NS } from './locales.ts'
import { KnowledgeIcon, KnowledgePanelView, knowledgeT } from './panel.tsx'
import { KnowledgeSettingsCard } from './settings-card.tsx'
import type { ObsidianSettings } from '../shared/settings-contract.ts'

export const inject = [
  'slots',
  'remote',
  'locale',
  'connection',
  'configForms',
  'shortcuts',
]

export async function apply(ctx: ClientContext): Promise<void> {
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => disposeRemote, 'dsh-obsidian: remote')

  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-obsidian: dictionaries')

  ctx.inject(['remote.knowledge'], (remoteCtx) => {
    const rpc = knowledgeRpcOf(remoteCtx)

    ctx.inject(['slots'], (slotCtx) => {
      slotCtx.effect(() => {
        const disposers = [
          slotCtx.slots.inject('sidebar.panellist', () => slotCtx.slots.register(
            { name: 'sidebar.panellist', id: 'knowledge', order: 20, label: () => slotCtx.locale.bind(NS)('panelLabel') },
            KnowledgeIcon,
          )),
          slotCtx.slots.inject('main', () => slotCtx.slots.register(
            { name: 'main', key: 'knowledge' },
            () => <KnowledgePanelView ctx={ctx} rpc={rpc} />,
          )),
        ]
        return () => disposers.forEach((dispose) => dispose())
      }, 'dsh-obsidian: knowledge panels')
    })

    ctx.inject(['configForms'], (formCtx) => {
      const settings = formCtx.configForms.get<ObsidianSettings>(NS)
      formCtx.effect(() => {
        return formCtx.configForms.whileServed([NS], () => formCtx.slots.inject('plugins.bundle.config', () => formCtx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-obsidian',
            locale: NS,
            registrant: 'dsh-obsidian',
          },
          (props) => <KnowledgeSettingsCard scope={settings} {...props} />,
        )))
      }, 'dsh-obsidian: settings card')
    })
  })
}
