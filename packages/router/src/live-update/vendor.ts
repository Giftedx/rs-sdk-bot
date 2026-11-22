// Compatibility shim re-exporting packages/fleet/src/live-update/vendor.ts.
export {
    SDK,
    SDK_PATCH,
    patchChangedFiles,
    patchCollisions,
    patchSections,
    resetVendor,
    vendorExact,
    vendorReleaseFiles,
    vendorState,
} from '../../../fleet/src/live-update/vendor';
