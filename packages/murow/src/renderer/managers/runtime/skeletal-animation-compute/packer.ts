import { getComputeProvider } from '../backend';

export function packAnimationData(...args: any[]): any {
    return getComputeProvider().packAnimationData(...args);
}
