import { ActionButton, MenuButton, ToggleSwitch, selectTriggerClassName, type MenuItemDef } from '@x3code/ui';
import type { BrowserLinkTarget } from '@x3code/contracts';

import { copy } from '@/strings';

import { SettingsCard } from './settings-card';
import { SettingsPageHeader } from './settings-page-header';
import { SettingsRow } from './settings-row';

export interface BrowserSectionProps {
  /** 链接与面板行为设置（settings.json 真相经 preferences 视图）。 */
  autoOpenPanel: boolean;
  externalLinkTarget: BrowserLinkTarget;
  localLinkTarget: BrowserLinkTarget;
  onAutoOpenPanelChange: (next: boolean) => void;
  onExternalLinkTargetChange: (next: BrowserLinkTarget) => void;
  onLocalLinkTargetChange: (next: BrowserLinkTarget) => void;
  /** 浏览器数据操作（M4 接 bw auth / profile 清理；先行占位接线）。 */
  onImportCookies: () => void;
  onClearData: () => void;
}

const TARGET_LABEL: Record<BrowserLinkTarget, string> = {
  builtin: copy.settings.browserTargetBuiltin,
  system: copy.settings.browserTargetSystem,
};

/** 设置 → 浏览器：链接分组（自动化行为 + 两类链接落点）+ 浏览器数据分组。 */
function BrowserSection(props: BrowserSectionProps) {
  const targetItems: ReadonlyArray<MenuItemDef> = (['builtin', 'system'] as const).map((value) => ({
    kind: 'item',
    id: value,
    label: TARGET_LABEL[value],
    selected: value === props.externalLinkTarget,
  }));
  const localItems: ReadonlyArray<MenuItemDef> = (['builtin', 'system'] as const).map((value) => ({
    kind: 'item',
    id: value,
    label: TARGET_LABEL[value],
    selected: value === props.localLinkTarget,
  }));
  return (
    <section>
      <SettingsPageHeader title={copy.settings.browserTitle} description={copy.settings.browserDesc} />
      <div className="flex flex-col gap-[16px]">
        <div>
          <p className="mb-[8px] px-[4px] text-[12px] font-medium text-muted-foreground">{copy.settings.browserLinkGroupTitle}</p>
          <SettingsCard className="divide-y divide-border">
            <SettingsRow title={copy.settings.browserAutoOpen} description={copy.settings.browserAutoOpenHint}>
              <ToggleSwitch
                checked={props.autoOpenPanel}
                onCheckedChange={props.onAutoOpenPanelChange}
                aria-label={copy.settings.browserAutoOpen}
              />
            </SettingsRow>
            <SettingsRow title={copy.settings.browserExternalTarget} description={copy.settings.browserExternalTargetHint}>
              <MenuButton
                trigger={<span className={selectTriggerClassName}>{TARGET_LABEL[props.externalLinkTarget]}</span>}
                items={targetItems}
                onSelect={(id) => props.onExternalLinkTargetChange(id as BrowserLinkTarget)}
                aria-label={copy.settings.browserExternalTarget}
              />
            </SettingsRow>
            <SettingsRow title={copy.settings.browserLocalTarget} description={copy.settings.browserLocalTargetHint}>
              <MenuButton
                trigger={<span className={selectTriggerClassName}>{TARGET_LABEL[props.localLinkTarget]}</span>}
                items={localItems}
                onSelect={(id) => props.onLocalLinkTargetChange(id as BrowserLinkTarget)}
                aria-label={copy.settings.browserLocalTarget}
              />
            </SettingsRow>
          </SettingsCard>
        </div>
        <div>
          <p className="mb-[8px] px-[4px] text-[12px] font-medium text-muted-foreground">{copy.settings.browserDataGroupTitle}</p>
          <SettingsCard className="divide-y divide-border">
            <SettingsRow title={copy.settings.browserImportCookies}>
              <ActionButton type="button" onClick={props.onImportCookies}>
                {copy.settings.browserImportAction}
              </ActionButton>
            </SettingsRow>
            <SettingsRow title={copy.settings.browserClearData}>
              <ActionButton type="button" onClick={props.onClearData}>
                {copy.settings.browserClearAction}
              </ActionButton>
            </SettingsRow>
          </SettingsCard>
        </div>
      </div>
    </section>
  );
}

export { BrowserSection };
