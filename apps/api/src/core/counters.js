import mongoose from 'mongoose';

/**
 * Next number of a named gapless sequence (first value 1), stored in `counters`.
 * Must run inside a transaction: if it aborts, the increment is rolled back and the
 * number is reused, so issued document numbers never skip.
 */
export async function nextSequence(name, session) {
  if (!session?.inTransaction()) {
    throw new Error(`nextSequence("${name}") must be called inside a transaction`);
  }
  const counter = await mongoose.connection
    .collection('counters')
    .findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: 'after', session },
    );
  return counter.value;
}
