import { addHydrogens } from '@/compute/hydrogens';
import { setSequenceMode } from '@/store/app';
import { createRoot } from 'react-dom/client';
import * as E from '@/engine';
import * as actions from '@/store/actions';
import { useApp, viewer } from '@/store/app';
import * as computeStore from '@/compute/store';
import * as computeTypes from '@/compute/types';
import * as data from '@/store/data';
import * as history from '@/store/history';
import * as protocol from '@/compute/protocol';
import * as dataActions from '@/store/dataActions';
import { funnelSteps, specReady } from '@/panels/charts';
import { renderPanel, renderChartCell } from '@/panels/export';
import { chartInstances } from '@/ui/data/ChartCell';
import { structureViewers } from '@/ui/data/StructureCell';
import { App } from './App';
// Registers what happens in the scene when a compute job finishes.
import '@/compute/apply';
import { initCompute } from '@/compute/store';
import './styles.css';

// Test-only override of the transparency mode, read by the engine at viewer creation.
const transparencyOverride = new URLSearchParams(location.search).get('transparency');
if (transparencyOverride === 'blended' || transparencyOverride === 'wboit' || transparencyOverride === 'dpoit') {
    Object.assign(window, { __ppTransparency: transparencyOverride });
}

if (new URLSearchParams(location.search).has('engineDebug')) E.enableEngineDebug();

// Hooks for scripts/selftest.cjs only — absent in normal runs.
if (new URLSearchParams(location.search).has('selftest')) {
    Object.assign(window, {
        __pp: {
            E,
            actions,
            useApp,
            viewer,
            compute: { store: computeStore },
            computeTypes,
            data,
            history,
            protocol,
            dataActions,
            charts: chartInstances,
            viewers: structureViewers,
            chartsApi: { funnelSteps, specReady },
            exportApi: { renderPanel, renderChartCell },
            hydrogens: { addHydrogens },
            setSequenceMode,
        },
    });
}

initCompute();

// No StrictMode: its double mount would create and dispose a WebGL context per viewer.
createRoot(document.getElementById('root')!).render(<App />);
