import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;
const count = { type: Number, default: 0 };

// The whole-branch point-in-time key numbers at the end of a day (IST), so Home can show how they
// changed since a month ago (Decision 4).
const dashboardSnapshotSchema = new mongoose.Schema(
  {
    branchId: { type: ObjectId, ref: 'Branch', required: true },
    date: { type: String, required: true },
    figures: {
      activeOrders: count,
      lateGarments: count,
      outstanding: count,
      overdueAmount: count,
      advancesHeld: count,
    },
  },
  { collection: 'dashboardSnapshots', versionKey: false, timestamps: true },
);
dashboardSnapshotSchema.index({ branchId: 1, date: 1 }, { name: 'branch_date', unique: true });

export const DashboardSnapshot = mongoose.models.DashboardSnapshot ?? mongoose.model('DashboardSnapshot', dashboardSnapshotSchema);
