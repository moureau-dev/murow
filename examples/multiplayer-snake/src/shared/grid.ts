import { Constants } from "./constants";

export class Grid {
    private _grid: Uint32Array;

    constructor(readonly size = Constants.GRID_SIZE) {
        this._grid = new Uint32Array(this.size * this.size);
    }

    set(x: number, y: number, entity: number) {
        this._grid[x + y * this.size] = entity;
    }

    find(x: number, y: number) {
        return this._grid[x + y * this.size];
    }

    index(x: number, y: number) {
        return x + y * this.size;
    }

    clear(x: number, y: number) {
        this._grid[x + y * this.size] = 0;
    }

    neighbors(x: number, y: number, fn: (x: number, y: number) => void) {
        fn(x + 1, y);
        fn(x - 1, y);
        fn(x, y + 1);
        fn(x, y - 1);
    }

    data() {
        return this._grid;
    }
}
