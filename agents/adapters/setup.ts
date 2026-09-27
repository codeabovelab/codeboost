import type { InvocationHandle } from '../contract.ts';
import { createContainerProfile, ProfileCreationCleanupError, type ContainerProfile,
  type ProfileOptions } from '../container/profile.ts';
import { createVendorNetwork, removeVendorNetwork, vendorNetworkResources,
  type VendorNetwork } from '../network/network.ts';
import { AdapterSetupCleanupError } from './supervisor.ts';
import type { AgentAdapterRequest } from './types.ts';

/** Cleanup is never cancelled and does not share the invocation budget, so an expired budget cannot skip it. */
const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * Adapter setup inside `launchInvocation`: create the vendor network, then the container profile, then hand the
 * profile to the supervisor. `signal` cancels whichever Docker call is in flight. A failure that removed everything
 * rejects with the startup error; one whose cleanup failed rejects with an error carrying `retryCleanup`, which the
 * launcher keeps retrying (a `VendorNetworkCreationCleanupError`, `ProfileCreationCleanupError` or
 * `AdapterSetupCleanupError`).
 */
export async function setUpProfile(request: AgentAdapterRequest, remaining: () => number, signal: AbortSignal,
  profileOptions: (network: VendorNetwork) => Omit<ProfileOptions, 'timeoutMs' | 'signal'>,
  start: (profile: ContainerProfile) => InvocationHandle): Promise<InvocationHandle> {
  const network = await createVendorNetwork(request.invocation, request.imageId, Math.min(60_000, remaining()), signal);
  let profile: ContainerProfile;
  try {
    profile = await createContainerProfile({ ...profileOptions(network), timeoutMs: Math.min(60_000, remaining()),
      signal });
  } catch (error) {
    // Profile creation removes the network itself once it has claimed it; otherwise the network is still ours.
    if (error instanceof ProfileCreationCleanupError) throw error;
    try { await removeVendorNetwork(network, CLEANUP_TIMEOUT_MS); }
    catch (cleanupError) {
      throw new AdapterSetupCleanupError(error, cleanupError,
        (budgetMs = CLEANUP_TIMEOUT_MS) => removeVendorNetwork(network, budgetMs), () => vendorNetworkResources(network));
    }
    throw error;
  }
  return start(profile);
}
