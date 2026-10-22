import { Feel, Player, Root, type Step } from "../reactor/player.reactor";

const strummed = Player.start()
  .press("I")
  .press("Major")
  .press("Straight")
  .press("Straight");

const next = strummed.bar();

const refuses = (misuse: () => unknown): boolean => {
  try {
    misuse();
    return false;
  } catch {
    return true;
  }
};

const pressBanana = () => {
  // @ts-expect-error a press carries a Root, Shape or Feel
  return Player.start().press("Banana");
};

const fourth = (steps: typeof strummed.steps) => {
  // @ts-expect-error steps holds at most 3
  return steps[3];
};

console.log(refuses(pressBanana), refuses(() => Feel.parse("Loud")), fourth(strummed.steps));

const show = ({ tag, clip }: Step): string => `${tag}(${clip.root} ${clip.shape} ${clip.feel})`;
console.log(strummed.steps.map(show).join(" "), strummed.root, strummed.clip?.feel);
console.log(next.steps.map(show).join(" "), next.clip);

/** The step queued last. Its length picks the tuple, so every index is in range. */
const newest = (steps: Player["steps"]): Step | null => {
  switch (steps.length) {
    case 0:
      return null;
    case 1:
      return steps[0];
    case 2:
      return steps[1];
    case 3:
      return steps[2];
  }
};

const queued = (["II", "Straight", "III", "Straight"] as const).reduce<Player>(
  (player, key) => player.press(key),
  strummed,
);
console.log(queued.steps.map(show).join(" "), newest(queued.steps)?.clip.root);

const stored = JSON.stringify(queued);
const restored = Player.parse(JSON.parse(stored));
console.log(stored);
console.log(JSON.stringify(restored) === stored, Object.isFrozen(restored.steps));

for (const misuse of [() => Root.parse("IX"), () => Player.parse({ ...JSON.parse(stored), feel: "Loud" })]) {
  try {
    misuse();
  } catch (error) {
    console.log(error instanceof TypeError ? error.message : error);
  }
}
