/**
 * Selects a random element from an array.
 * @param {Array<T>} arr The array to sample from.
 * @returns {T | undefined} A random element from the array, or undefined if the array is empty or not an array.
 * @template T
 */
function sample(arr) {
    if (!Array.isArray(arr) || arr.length === 0) {
        return undefined;
    }
    const randomIndex = Math.floor(Math.random() * arr.length);
    return arr[randomIndex];
}

/**
 * Randomly shuffles an array and returns a new array.
 * @param {Array<T>} arr The array to shuffle.
 * @returns {Array<T>} A new array with elements randomized.
 * @template T
 */
function shuffle(arr) {
    if (!Array.isArray(arr)) return [];
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

module.exports = {
    sample,
    shuffle,
}; 