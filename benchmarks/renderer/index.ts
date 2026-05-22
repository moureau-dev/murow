import { starfield, gpuParticles, gltf } from './programs';

export interface Program {
    name: string;
    desktopOnly?: boolean;
    init(canvas: HTMLCanvasElement, stats: HTMLElement): Promise<() => void>;
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

let cleanup: (() => void) | null = null;

async function loadProgram(name: string) {
    if (cleanup) {
        cleanup();
        cleanup = null;
    }

    const program = programs.find(p => p.name === name);
    if (!program) return;

    clearError();
    stats.textContent = 'Loading...';
    try {
        cleanup = await program.init(canvas, stats);
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
