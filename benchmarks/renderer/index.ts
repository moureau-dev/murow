import { starfield, gpuParticles, gltf } from './programs';

export interface NumberControl {
    kind: 'number';
    key: string;
    label: string;
    min: number;
    max: number;
    step: number;
    default: number;
    /** If true, changing this value requires a program restart. */
    restart?: boolean;
}

export type Control = NumberControl;

export type ControlValues = Record<string, number>;

export interface ProgramHandle {
    /** Called whenever a live (non-restart) control changes. */
    onControlChange?(key: string, value: number): void;
    /** Cleanup the program. */
    destroy(): void;
}

export interface Program {
    name: string;
    desktopOnly?: boolean;
    controls?: Control[];
    init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle>;
}

const isMobile = navigator.maxTouchPoints > 0;

const programs: Program[] = [
    starfield,
    gpuParticles,
    gltf,
].filter(p => !isMobile || !p.desktopOnly);

if (!navigator.gpu) {
    document.body.innerHTML = '<p style="color:white;padding:2rem;font-family:sans-serif">WebGPU is not supported in this browser.</p>';
    throw new Error('WebGPU not supported');
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const select = document.getElementById('program-select') as HTMLSelectElement;
const stats = document.getElementById('stats') as HTMLElement;
const errorOverlay = document.getElementById('error-overlay') as HTMLElement;
const errorBox = document.getElementById('error-box') as HTMLElement;
const controlsPanel = document.getElementById('program-controls') as HTMLElement;

function showError(err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    errorBox.textContent = `${e.name}: ${e.message}\n\n${e.stack ?? ''}`;
    errorOverlay.classList.add('visible');
}
function clearError() {
    errorOverlay.classList.remove('visible');
}

// Resize canvas to fill window
function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
}
resize();
window.addEventListener('resize', resize);

// Populate select
for (const program of programs) {
    const option = document.createElement('option');
    option.value = program.name;
    option.textContent = program.name;
    select.appendChild(option);
}

let handle: ProgramHandle | null = null;
let currentProgram: Program | null = null;
let currentValues: ControlValues = {};
let pendingRestart = false;

function defaultValues(program: Program): ControlValues {
    const values: ControlValues = {};
    for (const c of program.controls ?? []) {
        values[c.key] = c.default;
    }
    return values;
}

function setRestartPending(pending: boolean) {
    pendingRestart = pending;
    const btn = controlsPanel.querySelector<HTMLButtonElement>('[data-restart-btn]');
    if (btn) btn.disabled = !pending;
}

function renderControls(program: Program) {
    controlsPanel.innerHTML = '';
    const controls = program.controls ?? [];
    if (controls.length === 0) {
        controlsPanel.style.display = 'none';
        return;
    }
    controlsPanel.style.display = 'flex';

    const hasRestart = controls.some(c => c.restart);

    for (const c of controls) {
        const row = document.createElement('div');
        row.className = 'control-row';

        const label = document.createElement('label');
        label.textContent = c.label + (c.restart ? ' *' : '');
        label.title = c.restart ? 'Requires restart' : 'Live';

        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        input.value = String(currentValues[c.key]);

        const value = document.createElement('span');
        value.className = 'control-value';
        value.textContent = String(currentValues[c.key]);

        input.addEventListener('input', () => {
            const v = Number(input.value);
            if (!Number.isFinite(v)) return;
            currentValues[c.key] = v;
            value.textContent = String(v);
            if (c.restart) {
                setRestartPending(true);
            } else {
                handle?.onControlChange?.(c.key, v);
            }
        });

        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(value);
        controlsPanel.appendChild(row);
    }

    if (hasRestart) {
        const btn = document.createElement('button');
        btn.textContent = 'Restart';
        btn.dataset.restartBtn = '';
        btn.disabled = true;
        btn.addEventListener('click', () => {
            if (currentProgram) loadProgram(currentProgram.name, currentValues);
        });
        controlsPanel.appendChild(btn);
    }
}

async function loadProgram(name: string, values?: ControlValues) {
    if (handle) {
        handle.destroy();
        handle = null;
    }

    const program = programs.find(p => p.name === name);
    if (!program) return;

    currentProgram = program;
    currentValues = values ?? defaultValues(program);
    renderControls(program);
    setRestartPending(false);

    clearError();
    stats.textContent = 'Loading...';
    try {
        handle = await program.init(canvas, stats, { ...currentValues });
    } catch (err) {
        stats.textContent = 'Error';
        const isNoAdapter = err instanceof Error && err.message.includes('compatible GPU');
        showError(isNoAdapter
            ? new Error('Could not find a compatible GPU.\n\nMake sure hardware acceleration is enabled in your browser settings.')
            : err);
        console.error(err);
    }
}

select.addEventListener('change', () => loadProgram(select.value));

// Load first program
if (programs.length > 0) {
    loadProgram(programs[0].name);
}
