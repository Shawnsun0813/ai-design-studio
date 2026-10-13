// What the user may do about a failed step.
//
// Not every failure is the same kind of failure, and offering "Retry" for all of them is how a person ends up
// paying to re-run something that can never succeed (W5: the chosen direction needed an animation this region
// cannot have). The options are worked out from the facts — is this failure about the region's limits, can the
// direction the user chose be built here at all, is there another direction that passes the same check — rather
// than from whatever the event happened to record. Rounds from before that check existed go through the same
// door, so an old session recovers without rewriting a single event.
import { checkProposal } from './capabilities.mjs';

const ABOUT_SCOPE = /outside this region|cannot add|cannot deliver|cannot be built|only exists in the preview|@keyframes|animation/i;

export function isScopeFailure(failure) {
  return !!failure && ['SELECTOR_NOT_ALLOWED', 'OUTPUT_INVALID'].includes(failure.code) && ABOUT_SCOPE.test(String(failure.reason));
}

// `proposals`/`region` may be absent (a failure before any direction existed); then the failure is left as it is.
export function failureOptions({ failure, proposals, region, chosenId }) {
  if (!failure) return null;
  if (!isScopeFailure(failure) || !proposals?.length || !region) return failure;
  const chosen = proposals.find((x) => x.id === chosenId);
  const impossible = !!chosen && checkProposal({ proposal: chosen, region }).length > 0;
  const alternatives = proposals.filter((x) => x.id !== chosenId && checkProposal({ proposal: x, region }).length === 0).map((x) => x.id);
  const retryable = !!failure.retryable && !impossible;
  // Said plainly, because the recorded reason was written for whatever went wrong, not for what to do now.
  const note = impossible && !alternatives.length
    ? `Direction ${chosenId} cannot be built in this area, and neither can the other directions offered in this round. Nothing was written and the page is unchanged. Your goal, the reference and the reading of it stay in the record; the step left here is to end this round.`
    : impossible
      ? `Direction ${chosenId} cannot be built in this area, so running this step again would hit the same wall. ${alternatives.join(' and ')} can be built here — switching costs no new work.`
      : alternatives.length
        ? `Nothing was written. You can try this step again, or switch to ${alternatives.join(' or ')} without the team starting over.`
        : 'Nothing was written and the page is unchanged.';
  return {
    ...failure,
    retryable,
    impossible,
    alternatives,
    note,
    options: [...(retryable ? ['retry'] : []), ...(alternatives.length ? ['choose_again'] : []), 'cancel'],
  };
}
