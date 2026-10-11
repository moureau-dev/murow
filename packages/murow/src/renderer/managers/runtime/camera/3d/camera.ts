import { Camera3D, type Camera3DOptions } from '../../../../camera/camera-3d';

/**
 * CameraManager is the public camera facade over `Camera3D`. It carries no
 * additional state: the shared camera implementation is delegated to directly,
 * which keeps the 2D and 3D renderers on one camera class.
 */
export class CameraManager extends Camera3D {
    constructor(options: Camera3DOptions = {}) {
        super(options);
    }
}
