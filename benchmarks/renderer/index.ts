import { starfield } from './programs/starfield';

export interface Program {
    name: string;
    init(canvas: HTMLCanvasElement, stats: HTMLElement): Promise<() => void>;
}

const programs: Program[] = [
    starfield,
];

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const select = document.getElementById('program-select') as HTMLSelectElement;
const stats = document.getElementById('stats') as HTMLElement;

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

    stats.textContent = 'Loading...';
    cleanup = await program.init(canvas, stats);
}

select.addEventListener('change', () => loadProgram(select.value));

// Load first program
if (programs.length > 0) {
    loadProgram(programs[0].name);
}
