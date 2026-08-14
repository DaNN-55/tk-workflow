export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      account_blueprint_versions: {
        Row: {
          account_id: string
          created_at: string
          id: string
          is_active: boolean
          policy: Json
          version: number
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          is_active?: boolean
          policy: Json
          version: number
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          is_active?: boolean
          policy?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "account_blueprint_versions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      account_memberships: {
        Row: {
          account_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          account_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          account_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_memberships_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          created_at: string
          current_blueprint_version_id: string | null
          id: string
          name: string
          slug: string
          timezone: string
        }
        Insert: {
          created_at?: string
          current_blueprint_version_id?: string | null
          id?: string
          name: string
          slug: string
          timezone: string
        }
        Update: {
          created_at?: string
          current_blueprint_version_id?: string | null
          id?: string
          name?: string
          slug?: string
          timezone?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_current_blueprint_version_fk"
            columns: ["id", "current_blueprint_version_id"]
            isOneToOne: false
            referencedRelation: "account_blueprint_versions"
            referencedColumns: ["account_id", "id"]
          },
        ]
      }
      approvals: {
        Row: {
          actor_id: string
          created_at: string
          decision: string
          episode_id: string
          id: string
          reason: string
          stage: Database["public"]["Enums"]["episode_stage"]
        }
        Insert: {
          actor_id: string
          created_at?: string
          decision: string
          episode_id: string
          id?: string
          reason: string
          stage: Database["public"]["Enums"]["episode_stage"]
        }
        Update: {
          actor_id?: string
          created_at?: string
          decision?: string
          episode_id?: string
          id?: string
          reason?: string
          stage?: Database["public"]["Enums"]["episode_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "approvals_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      artifacts: {
        Row: {
          artifact_type: string
          created_at: string
          episode_id: string
          file_size: number
          id: string
          producer_task_id: string | null
          relative_path: string
          sha256: string
        }
        Insert: {
          artifact_type: string
          created_at?: string
          episode_id: string
          file_size: number
          id?: string
          producer_task_id?: string | null
          relative_path: string
          sha256: string
        }
        Update: {
          artifact_type?: string
          created_at?: string
          episode_id?: string
          file_size?: number
          id?: string
          producer_task_id?: string | null
          relative_path?: string
          sha256?: string
        }
        Relationships: [
          {
            foreignKeyName: "artifacts_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "artifacts_producer_task_id_fkey"
            columns: ["producer_task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      blueprint_change_suggestions: {
        Row: {
          account_id: string
          created_at: string
          created_by: string
          decision_reason: string | null
          id: string
          learning_report_id: string
          proposed_blueprint_version_id: string | null
          proposed_policy: Json
          rationale: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_blueprint_version_id: string
          status: "pending" | "approved" | "rejected"
        }
        Insert: {
          account_id: string
          created_at?: string
          created_by: string
          decision_reason?: string | null
          id?: string
          learning_report_id: string
          proposed_blueprint_version_id?: string | null
          proposed_policy: Json
          rationale: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_blueprint_version_id: string
          status?: "pending" | "approved" | "rejected"
        }
        Update: {
          account_id?: string
          created_at?: string
          created_by?: string
          decision_reason?: string | null
          id?: string
          learning_report_id?: string
          proposed_blueprint_version_id?: string | null
          proposed_policy?: Json
          rationale?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          source_blueprint_version_id?: string
          status?: "pending" | "approved" | "rejected"
        }
        Relationships: [
          {
            foreignKeyName: "blueprint_change_suggestions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_change_suggestions_learning_report_id_fkey"
            columns: ["learning_report_id"]
            isOneToOne: false
            referencedRelation: "learning_reports"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_change_suggestions_proposed_blueprint_version_id_fkey"
            columns: ["proposed_blueprint_version_id"]
            isOneToOne: false
            referencedRelation: "account_blueprint_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blueprint_change_suggestions_source_blueprint_version_id_fkey"
            columns: ["source_blueprint_version_id"]
            isOneToOne: false
            referencedRelation: "account_blueprint_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_locks: {
        Row: {
          episode_id: string
          expires_at: string
          locked_at: string
          resource_key: string
        }
        Insert: {
          episode_id: string
          expires_at: string
          locked_at?: string
          resource_key: string
        }
        Update: {
          episode_id?: string
          expires_at?: string
          locked_at?: string
          resource_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_locks_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events: {
        Row: {
          account_id: string
          actor_id: string | null
          created_at: string
          episode_id: string | null
          event_type: string
          id: string
          payload: Json
        }
        Insert: {
          account_id: string
          actor_id?: string | null
          created_at?: string
          episode_id?: string | null
          event_type: string
          id?: string
          payload?: Json
        }
        Update: {
          account_id?: string
          actor_id?: string | null
          created_at?: string
          episode_id?: string | null
          event_type?: string
          id?: string
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_events_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      episodes: {
        Row: {
          account_id: string
          blueprint_version_id: string
          created_at: string
          id: string
          stage: Database["public"]["Enums"]["episode_stage"]
          title: string
          updated_at: string
        }
        Insert: {
          account_id: string
          blueprint_version_id: string
          created_at?: string
          id?: string
          stage?: Database["public"]["Enums"]["episode_stage"]
          title: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          blueprint_version_id?: string
          created_at?: string
          id?: string
          stage?: Database["public"]["Enums"]["episode_stage"]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "episodes_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "episodes_blueprint_belongs_to_account_fk"
            columns: ["account_id", "blueprint_version_id"]
            isOneToOne: false
            referencedRelation: "account_blueprint_versions"
            referencedColumns: ["account_id", "id"]
          },
        ]
      }
      experiments: {
        Row: {
          created_at: string
          episode_id: string
          guardrail_metrics: string[]
          hypothesis: string
          id: string
          primary_metric: string
          primary_variable: string
        }
        Insert: {
          created_at?: string
          episode_id: string
          guardrail_metrics?: string[]
          hypothesis: string
          id?: string
          primary_metric: string
          primary_variable: string
        }
        Update: {
          created_at?: string
          episode_id?: string
          guardrail_metrics?: string[]
          hypothesis?: string
          id?: string
          primary_metric?: string
          primary_variable?: string
        }
        Relationships: [
          {
            foreignKeyName: "experiments_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: true
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_snapshots: {
        Row: {
          captured_at: string
          captured_by: string
          episode_id: string
          id: string
          metrics: Json
        }
        Insert: {
          captured_at: string
          captured_by: string
          episode_id: string
          id?: string
          metrics: Json
        }
        Update: {
          captured_at?: string
          captured_by?: string
          episode_id?: string
          id?: string
          metrics?: Json
        }
        Relationships: [
          {
            foreignKeyName: "metric_snapshots_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      learning_reports: {
        Row: {
          created_at: string
          created_by: string
          episode_id: string
          id: string
          recommendation: "keep" | "change" | "kill" | "insufficient_data"
          summary: string
        }
        Insert: {
          created_at?: string
          created_by: string
          episode_id: string
          id?: string
          recommendation: "keep" | "change" | "kill" | "insufficient_data"
          summary: string
        }
        Update: {
          created_at?: string
          created_by?: string
          episode_id?: string
          id?: string
          recommendation?: "keep" | "change" | "kill" | "insufficient_data"
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "learning_reports_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: true
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      state_transitions: {
        Row: {
          actor_id: string | null
          created_at: string
          episode_id: string
          from_stage: Database["public"]["Enums"]["episode_stage"] | null
          id: string
          reason: string
          to_stage: Database["public"]["Enums"]["episode_stage"]
        }
        Insert: {
          actor_id?: string | null
          created_at?: string
          episode_id: string
          from_stage?: Database["public"]["Enums"]["episode_stage"] | null
          id?: string
          reason: string
          to_stage: Database["public"]["Enums"]["episode_stage"]
        }
        Update: {
          actor_id?: string | null
          created_at?: string
          episode_id?: string
          from_stage?: Database["public"]["Enums"]["episode_stage"] | null
          id?: string
          reason?: string
          to_stage?: Database["public"]["Enums"]["episode_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "state_transitions_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          actual_cost_cents: number | null
          attempt: number
          budget_limit_cents: number
          claimed_at: string | null
          completed_at: string | null
          created_at: string
          episode_id: string
          id: string
          input_snapshot: Json
          last_result: Json | null
          max_attempts: number
          model: string
          prompt_version: string
          provider: string
          status: Database["public"]["Enums"]["task_status"]
          task_type: string
        }
        Insert: {
          actual_cost_cents?: number | null
          attempt?: number
          budget_limit_cents?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          episode_id: string
          id?: string
          input_snapshot?: Json
          last_result?: Json | null
          max_attempts?: number
          model?: string
          prompt_version?: string
          provider?: string
          status?: Database["public"]["Enums"]["task_status"]
          task_type: string
        }
        Update: {
          actual_cost_cents?: number | null
          attempt?: number
          budget_limit_cents?: number
          claimed_at?: string | null
          completed_at?: string | null
          created_at?: string
          episode_id?: string
          id?: string
          input_snapshot?: Json
          last_result?: Json | null
          max_attempts?: number
          model?: string
          prompt_version?: string
          provider?: string
          status?: Database["public"]["Enums"]["task_status"]
          task_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_episode_id_fkey"
            columns: ["episode_id"]
            isOneToOne: false
            referencedRelation: "episodes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      activate_blueprint_version: {
        Args: { p_account_id: string; p_blueprint_version_id: string }
        Returns: {
          account_id: string
          created_at: string
          id: string
          is_active: boolean
          policy: Json
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "account_blueprint_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      bootstrap_platform: {
        Args: {
          p_account_name: string
          p_account_slug: string
          p_policy: Json
          p_timezone: string
        }
        Returns: {
          created_at: string
          current_blueprint_version_id: string | null
          id: string
          name: string
          slug: string
          timezone: string
        }
        SetofOptions: {
          from: "*"
          to: "accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_account: {
        Args: {
          p_account_name: string
          p_account_slug: string
          p_policy: Json
          p_timezone: string
        }
        Returns: {
          created_at: string
          current_blueprint_version_id: string | null
          id: string
          name: string
          slug: string
          timezone: string
        }
        SetofOptions: {
          from: "*"
          to: "accounts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_blueprint_version: {
        Args: { p_account_id: string; p_policy: Json }
        Returns: {
          account_id: string
          created_at: string
          id: string
          is_active: boolean
          policy: Json
          version: number
        }
        SetofOptions: {
          from: "*"
          to: "account_blueprint_versions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_episode: {
        Args: {
          p_account_id: string
          p_blueprint_version_id: string
          p_title: string
        }
        Returns: {
          account_id: string
          blueprint_version_id: string
          created_at: string
          id: string
          stage: Database["public"]["Enums"]["episode_stage"]
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "episodes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_blueprint_change_suggestion: {
        Args: { p_learning_report_id: string; p_proposed_policy: Json; p_rationale: string }
        Returns: {
          account_id: string
          created_at: string
          created_by: string
          decision_reason: string | null
          id: string
          learning_report_id: string
          proposed_blueprint_version_id: string | null
          proposed_policy: Json
          rationale: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_blueprint_version_id: string
          status: "pending" | "approved" | "rejected"
        }
        SetofOptions: { from: "*"; to: "blueprint_change_suggestions"; isOneToOne: true; isSetofReturn: false }
      }
      define_experiment: {
        Args: {
          p_episode_id: string
          p_guardrail_metrics: string[]
          p_hypothesis: string
          p_primary_metric: string
          p_primary_variable: string
        }
        Returns: {
          created_at: string
          episode_id: string
          guardrail_metrics: string[]
          hypothesis: string
          id: string
          primary_metric: string
          primary_variable: string
        }
        SetofOptions: { from: "*"; to: "experiments"; isOneToOne: true; isSetofReturn: false }
      }
      has_required_artifacts: {
        Args: {
          p_episode_id: string
          p_to_stage: Database["public"]["Enums"]["episode_stage"]
        }
        Returns: boolean
      }
      is_account_member: {
        Args: { target_account_id: string }
        Returns: boolean
      }
      is_allowed_episode_transition: {
        Args: {
          from_stage: Database["public"]["Enums"]["episode_stage"]
          to_stage: Database["public"]["Enums"]["episode_stage"]
        }
        Returns: boolean
      }
      record_publish_package: {
        Args: {
          p_episode_id: string
          p_file_size: number
          p_relative_path: string
          p_sha256: string
        }
        Returns: {
          artifact_type: string
          created_at: string
          episode_id: string
          file_size: number
          id: string
          producer_task_id: string | null
          relative_path: string
          sha256: string
        }
        SetofOptions: {
          from: "*"
          to: "artifacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      record_learning_report: {
        Args: { p_episode_id: string; p_recommendation: "keep" | "change" | "kill" | "insufficient_data"; p_summary: string }
        Returns: {
          created_at: string
          created_by: string
          episode_id: string
          id: string
          recommendation: "keep" | "change" | "kill" | "insufficient_data"
          summary: string
        }
        SetofOptions: { from: "*"; to: "learning_reports"; isOneToOne: true; isSetofReturn: false }
      }
      record_weekly_metric_snapshot: {
        Args: { p_captured_at: string; p_episode_id: string; p_metrics: Json }
        Returns: {
          captured_at: string
          captured_by: string
          episode_id: string
          id: string
          metrics: Json
        }
        SetofOptions: { from: "*"; to: "metric_snapshots"; isOneToOne: true; isSetofReturn: false }
      }
      review_blueprint_change_suggestion: {
        Args: { p_decision: "approved" | "rejected"; p_decision_reason: string; p_suggestion_id: string }
        Returns: {
          account_id: string
          created_at: string
          created_by: string
          decision_reason: string | null
          id: string
          learning_report_id: string
          proposed_blueprint_version_id: string | null
          proposed_policy: Json
          rationale: string
          reviewed_at: string | null
          reviewed_by: string | null
          source_blueprint_version_id: string
          status: "pending" | "approved" | "rejected"
        }
        SetofOptions: { from: "*"; to: "blueprint_change_suggestions"; isOneToOne: true; isSetofReturn: false }
      }
      record_publish_package_verification: {
        Args: { p_episode_id: string; p_file_size: number; p_sha256: string }
        Returns: {
          budget_limit_cents: number | null
          created_at: string
          episode_id: string
          id: string
          input_snapshot: Json
          max_attempts: number
          status: Database["public"]["Enums"]["task_status"]
          task_type: string
        }
        SetofOptions: { from: "*"; to: "tasks"; isOneToOne: true; isSetofReturn: false }
      }
      transition_episode: {
        Args: {
          p_episode_id: string
          p_reason: string
          p_to_stage: Database["public"]["Enums"]["episode_stage"]
        }
        Returns: {
          account_id: string
          blueprint_version_id: string
          created_at: string
          id: string
          stage: Database["public"]["Enums"]["episode_stage"]
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "episodes"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      episode_stage:
        | "brief_draft"
        | "script_draft"
        | "script_review"
        | "script_approved"
        | "visual_draft"
        | "visual_review"
        | "visual_approved"
        | "storyboard_draft"
        | "storyboard_review"
        | "storyboard_approved"
        | "production_ready"
        | "render_ready"
        | "qc_review"
        | "qc_passed"
        | "publish_ready"
        | "publishing_review"
        | "published"
        | "metrics_collecting"
        | "learning_recorded"
      member_role: "owner" | "worker"
      task_status: "ready" | "running" | "completed" | "blocked" | "failed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      episode_stage: [
        "brief_draft",
        "script_draft",
        "script_review",
        "script_approved",
        "visual_draft",
        "visual_review",
        "visual_approved",
        "storyboard_draft",
        "storyboard_review",
        "storyboard_approved",
        "production_ready",
        "render_ready",
        "qc_review",
        "qc_passed",
        "publish_ready",
        "publishing_review",
        "published",
        "metrics_collecting",
        "learning_recorded",
      ],
      member_role: ["owner", "worker"],
      task_status: ["ready", "running", "completed", "blocked", "failed"],
    },
  },
} as const
