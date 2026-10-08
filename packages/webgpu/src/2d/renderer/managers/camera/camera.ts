import { Camera2D } from '../../../../camera/camera-2d';

/**
 * CameraManager2D is the public 2D camera facade over `Camera2D`. It carries no
 * additional state: the shared camera implementation is delegated to directly.
 */
export class CameraManager2D extends Camera2D {
    constructor(width: number, height: number) {
        super(width, height);
    }
}
