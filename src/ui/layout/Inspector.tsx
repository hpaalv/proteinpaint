import { useApp, type InspectorTab } from '@/store/app';
import { Icon, type IconName } from '../components/Icon';
import { cx } from '../components/Primitives';
import { ColorPanel } from '../panels/ColorPanel';
import { ComparePanel } from '../panels/ComparePanel';
import { InterfacePanel } from '../panels/InterfacePanel';
import { MeasurePanel } from '../panels/MeasurePanel';
import { StudioPanel } from '../panels/StudioPanel';
import { FigurePanel } from '../panels/FigurePanel';
import { SelectPanel } from '../panels/SelectPanel';
import { StylePanel } from '../panels/StylePanel';
import { AnalysisPanel } from '../analysis/AnalysisPanel';

const TABS: { id: InspectorTab; label: string; icon: IconName; key: string }[] = [
    { id: 'style', label: 'Estilo', icon: 'layers', key: '1' },
    { id: 'color', label: 'Cor', icon: 'palette', key: '2' },
    { id: 'select', label: 'Seleção', icon: 'select', key: '3' },
    { id: 'interface', label: 'Interface', icon: 'link', key: '4' },
    { id: 'compare', label: 'Comparar', icon: 'align', key: '5' },
    { id: 'measure', label: 'Medidas', icon: 'ruler', key: '6' },
    { id: 'scene', label: 'Estúdio', icon: 'sun', key: '7' },
    { id: 'figure', label: 'Figura', icon: 'camera', key: '8' },
    { id: 'analysis', label: 'Análises', icon: 'flask', key: '9' },
];


function Panel({ tab }: { tab: InspectorTab }) {
    switch (tab) {
        case 'style':
            return <StylePanel />;
        case 'color':
            return <ColorPanel />;
        case 'select':
            return <SelectPanel />;
        case 'interface':
            return <InterfacePanel />;
        case 'compare':
            return <ComparePanel />;
        case 'measure':
            return <MeasurePanel />;
        case 'scene':
            return <StudioPanel />;
        case 'figure':
            return <FigurePanel />;
        case 'analysis':
            return <AnalysisPanel />;
    }
}

export function Inspector() {
    const tab = useApp((s) => s.tab);
    const index = TABS.findIndex((t) => t.id === tab);
    return (
        <aside className="flex w-[350px] shrink-0 border-l border-stroke bg-bg-1">
            <div className="scroll-themed min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
                <div className="sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-stroke bg-bg-1/90 px-3 backdrop-blur-md">
                    <Icon name={TABS[index]!.icon} size={14} className="text-accent" />
                    <span key={tab} className="fade-in text-[12.5px] font-semibold tracking-tight">
                        {TABS[index]!.label}
                    </span>
                    <span className="mono ml-auto text-[10.5px] text-text-2">Alt+{TABS[index]!.key}</span>
                </div>
                {/* Keyed: switching tabs remounts the panel, which plays its entrance. */}
                <div key={tab} className="panel-enter stagger">
                    <Panel tab={tab} />
                </div>
            </div>
            <nav className="relative flex w-12 shrink-0 flex-col items-center gap-1 border-l border-stroke py-2">
                {/* One indicator that slides between tabs instead of a background per button. */}
                <div
                    className="pointer-events-none absolute top-2 left-1 h-11 w-10 rounded-md bg-accent/15 ring-1 ring-accent/30 transition-transform duration-300 ease-[var(--ease-spring)]"
                    style={{ transform: `translateY(calc(${index} * 3rem))` }}
                />
                <div
                    className="pointer-events-none absolute top-2 left-0 h-11 w-[3px] rounded-r bg-accent transition-transform duration-300 ease-[var(--ease-spring)]"
                    style={{ transform: `translateY(calc(${index} * 3rem)) scaleY(0.55)` }}
                />
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        title={`${t.label} (Alt+${t.key})`}
                        onClick={() => useApp.setState({ tab: t.id })}
                        className={cx(
                            'press relative flex h-11 w-10 flex-col items-center justify-center gap-0.5 rounded-md text-[9.5px]',
                            tab === t.id ? 'text-accent' : 'text-text-2 hover:bg-bg-3/70 hover:text-text-0',
                        )}
                    >
                        <Icon name={t.icon} size={17} className={cx('transition-transform duration-300 ease-[var(--ease-spring)]', tab === t.id && 'scale-110')} />
                        {t.label}
                    </button>
                ))}
            </nav>
        </aside>
    );
}

export const TAB_KEYS = TABS.map((t) => [t.key, t.id] as const);
