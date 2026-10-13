import { copy } from '@/strings';
import { RuntimeContent } from '@/screens/runtime-content';

import type { SettingsScreenProps } from './use-settings-screen';
import { AgentsSection } from './agents-section';
import { GeneralSection } from './general-section';
import { DevicesSection } from './devices-section';
import { HistorySection } from './history-section';
import { PermissionsSection } from './permissions-section';
import { ProvidersSection } from './providers-section';
import { SettingsPageHeader } from './settings-page-header';
import { SettingsSectionNav } from './settings-section-nav';
import { SkillsSection } from './skills-section';
import { PluginsSection } from './plugins-section';

/**
 * 设置页容器：不透明全屏 overlay，左 nav（320px，sidebar 底色）+ 右内容两栏；
 * 分区状态/派发与数据装配都在 use-settings-screen，本组件只做展示分派。
 * Esc 关闭由父层全局监听，本组件不挂键盘事件。
 */
function SettingsScreen({ open, onClose, section, onSelectSection, general, devices, providers, permissions, agents, skills, plugins, history, runtime, runtimeAttention }: SettingsScreenProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex bg-background">
      <aside className="h-full w-[320px] shrink-0 border-r border-border bg-sidebar">
        <SettingsSectionNav section={section} onSelectSection={onSelectSection} onClose={onClose} runtimeAttention={runtimeAttention} />
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1000px] flex-col px-[80px] py-[56px]">
          {section === 'general' ? (
            <GeneralSection {...general} />
          ) : section === 'providers' ? (
            <ProvidersSection {...providers} />
          ) : section === 'devices' ? (
            <DevicesSection {...devices} />
          ) : section === 'permissions' ? (
            <PermissionsSection {...permissions} />
          ) : section === 'agents' ? (
            <AgentsSection {...agents} />
          ) : section === 'skills' ? (
            <SkillsSection {...skills} />
          ) : section === 'plugins' ? (
            <PluginsSection {...plugins} />
          ) : section === 'history' ? (
            <HistorySection {...history} />
          ) : (
            <>
              <SettingsPageHeader title={copy.settings.runtimeTitle} description={copy.settings.runtimeDesc} />
              <RuntimeContent {...runtime} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { SettingsScreen };
