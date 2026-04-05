import mongoose from "mongoose";

const userMemorySchema = new mongoose.Schema({
  userId: String,
  conversationHistory: [
    {
      role: String,
      content: String,
      timestamp: Date
    }
  ],
  personalityProfile: {
    energyPreference: String,
    tonePreference: String,
    interests: [String],
    interactionCount: Number
  }
});

const UserMemory = mongoose.model("UserMemory", userMemorySchema);

export async function getOrCreateMemory(userId) {
  let memory = await UserMemory.findOne({ userId });

  if (!memory) {
    memory = await UserMemory.create({
      userId,
      conversationHistory: [],
      personalityProfile: {
        energyPreference: "neutral",
        tonePreference: "balanced",
        interests: [],
        interactionCount: 0
      }
    });
  }

  return memory;
}

export async function updateMemory(memory, userMessage, aiReply) {
  memory.conversationHistory.push(
    { role: "user", content: userMessage, timestamp: new Date() },
    { role: "assistant", content: aiReply, timestamp: new Date() }
  );

  memory.personalityProfile.interactionCount += 1;

  if (memory.conversationHistory.length > 50) {
    memory.conversationHistory =
      memory.conversationHistory.slice(-50);
  }

  await memory.save();
}