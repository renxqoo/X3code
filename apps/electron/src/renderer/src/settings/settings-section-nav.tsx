import { Activity, ArrowLeft, Bot, Boxes, History, Puzzle, Rocket, Settings2, ShieldCheck, Smartphone, Sparkles } from 'lucide-react';

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { copy } from '@/strings';
import { SETTINGS_NAV_GROUPS, type SettingsSectionId } from './settings-sections';

/** 分区条目图标（非文案，可模块级固定）；文案标签在渲染期按当前 locale 解析。 */
const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  general: Settings2,
  providers: Boxes,
  devices: Smartphone,
  permissions: ShieldCheck,
  agents: Bot,
  skills: Sparkles,
  plugins: Puzzle,
  history: History,
  runtime: Activity,
};

type SettingsSectionNavProps = {
  section: SettingsSectionId
  onSelectSection: (id: SettingsSectionId) => void
  /** 顶部「返回工作区」= 关闭设置页。 */
  onClose: () => void
  /** 运行状态分区行的异常红点（宿主非就绪或存在异常会话）。 */
  runtimeAttention: boolean
}

/** 设置分区导航：返回链接 + 三组条目（图标+文案，选中灰胶囊）+ 底部虚线引导入口。 */
function SettingsSectionNav({ section, onSelectSection, onClose, runtimeAttention }: SettingsSectionNavProps) {
  const groupTitles: Record<(typeof SETTINGS_NAV_GROUPS)[number]['id'], string> = {
    basics: copy.settings.navGroupBasics,
    agent: copy.settings.navGroupAgent,
    data: copy.settings.navGroupData,
  };
  const sectionLabels: Record<SettingsSectionId, string> = {
    general: copy.settings.generalTitle,
    providers: copy.settings.providersTitle,
    devices: copy.settings.devicesTitle,
    permissions: copy.settings.permissionsTitle,
    agents: copy.settings.agentsTitle,
    skills: copy.settings.skillsTitle,
    plugins: copy.settings.pluginsTitle,
    history: copy.settings.historyTitle,
    runtime: copy.settings.runtimeTitle,
  };
  return (
    <nav aria-label={copy.settings.title} className="flex h-full min-h-0 flex-col px-[16px] pb-[16px] pt-[20px]">
      <button
        type="button"
        onClick={onClose}
        className="flex h-9 w-full cursor-pointer items-center gap-[8px] rounded-lg mt-[36px] px-[10px] text-left text-[13px] leading-none text-muted-foreground outline-none select-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ArrowLeft className="size-[15px] shrink-0" strokeWidth={1.75} />
        {copy.settings.backToWorkspace}
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto pt-[24px]">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <div key={group.id} className="pb-[20px]">
            <p className="px-[10px] pb-[6px] text-[11px] leading-[16px] font-medium tracking-[0.08em] text-muted-foreground">
              {groupTitles[group.id]}
            </p>
            <div className="flex flex-col gap-[2px]">
              {group.sections.map((id) => {
                const Icon = SECTION_ICONS[id];
                const selected = id === section;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelectSection(id)}
                    className={cn(
                      'flex h-9 w-full cursor-pointer items-center gap-[10px] rounded-lg px-[10px] text-left text-[13px] leading-none outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      selected ? 'bg-muted font-medium text-foreground' : 'text-foreground/90 hover:bg-muted/50 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="min-w-0 truncate">{sectionLabels[id]}</span>
                    {id === 'runtime' && runtimeAttention ? (
                      <span aria-label={copy.settings.runtimeAttention} className="ml-auto inline-flex size-[6px] shrink-0 rounded-full bg-destructive" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onSelectSection('general')}
        className="mt-auto flex h-9 w-full shrink-0 cursor-pointer items-center gap-[10px] rounded-lg border border-dashed border-border px-[10px] text-left text-[13px] leading-none text-muted-foreground outline-none select-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Rocket className="size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
        {copy.settings.navOnboarding}
      </button>
    </nav>
  );
}

export { SettingsSectionNav };
