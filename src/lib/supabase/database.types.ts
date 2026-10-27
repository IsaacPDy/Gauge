export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      alert_rules: {
        Row: {
          category: string
          created_at: string
          enabled: boolean
          id: string
          notify_email: boolean
          notify_in_app: boolean
          thresholds: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          category: string
          created_at?: string
          enabled?: boolean
          id?: string
          notify_email?: boolean
          notify_in_app?: boolean
          thresholds?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          category?: string
          created_at?: string
          enabled?: boolean
          id?: string
          notify_email?: boolean
          notify_in_app?: boolean
          thresholds?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      alerts: {
        Row: {
          account_id: string | null
          acknowledged_at: string | null
          acknowledged_by: string | null
          application_id: string | null
          category: string
          connection_id: string | null
          created_at: string
          current_value: number | null
          cycle_reset_at: string | null
          cycle_start: string | null
          data_updated_at: string | null
          dedupe_key: string
          details: Json
          forecast_breach_at: string | null
          group_key: string
          id: string
          limit_value: number | null
          message: string
          metric_key: string | null
          muted_until: string | null
          percent_used: number | null
          quota_rule_id: string | null
          recommended_action: string | null
          resolved_at: string | null
          resource_id: string | null
          rule_id: string | null
          severity: string
          status: string
          title: string
          unit: string | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          application_id?: string | null
          category: string
          connection_id?: string | null
          created_at?: string
          current_value?: number | null
          cycle_reset_at?: string | null
          cycle_start?: string | null
          data_updated_at?: string | null
          dedupe_key: string
          details?: Json
          forecast_breach_at?: string | null
          group_key: string
          id?: string
          limit_value?: number | null
          message: string
          metric_key?: string | null
          muted_until?: string | null
          percent_used?: number | null
          quota_rule_id?: string | null
          recommended_action?: string | null
          resolved_at?: string | null
          resource_id?: string | null
          rule_id?: string | null
          severity: string
          status?: string
          title: string
          unit?: string | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          application_id?: string | null
          category?: string
          connection_id?: string | null
          created_at?: string
          current_value?: number | null
          cycle_reset_at?: string | null
          cycle_start?: string | null
          data_updated_at?: string | null
          dedupe_key?: string
          details?: Json
          forecast_breach_at?: string | null
          group_key?: string
          id?: string
          limit_value?: number | null
          message?: string
          metric_key?: string | null
          muted_until?: string | null
          percent_used?: number | null
          quota_rule_id?: string | null
          recommended_action?: string | null
          resolved_at?: string | null
          resource_id?: string | null
          rule_id?: string | null
          severity?: string
          status?: string
          title?: string
          unit?: string | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_quota_rule_id_fkey"
            columns: ["quota_rule_id"]
            isOneToOne: false
            referencedRelation: "quota_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "provider_resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "alert_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      application_resources: {
        Row: {
          application_id: string
          created_at: string
          resource_id: string
          workspace_id: string
        }
        Insert: {
          application_id: string
          created_at?: string
          resource_id: string
          workspace_id: string
        }
        Update: {
          application_id?: string
          created_at?: string
          resource_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "application_resources_application_id_workspace_id_fkey"
            columns: ["application_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "application_resources_resource_id_workspace_id_fkey"
            columns: ["resource_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "provider_resources"
            referencedColumns: ["id", "workspace_id"]
          },
        ]
      }
      applications: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          details: Json
          id: number
          target_id: string | null
          target_type: string | null
          workspace_id: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: never
          target_id?: string | null
          target_type?: string | null
          workspace_id?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          details?: Json
          id?: never
          target_id?: string | null
          target_type?: string | null
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_records: {
        Row: {
          account_id: string | null
          amount: number
          calculation: Json
          computed_at: string
          connection_id: string | null
          currency: string
          id: string
          kind: string
          metric_key: string | null
          period_end: string
          period_start: string
          pricing_rule_id: string | null
          pricing_version: string | null
          resource_id: string | null
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          amount: number
          calculation?: Json
          computed_at?: string
          connection_id?: string | null
          currency: string
          id?: string
          kind: string
          metric_key?: string | null
          period_end: string
          period_start: string
          pricing_rule_id?: string | null
          pricing_version?: string | null
          resource_id?: string | null
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          amount?: number
          calculation?: Json
          computed_at?: string
          connection_id?: string | null
          currency?: string
          id?: string
          kind?: string
          metric_key?: string | null
          period_end?: string
          period_start?: string
          pricing_rule_id?: string | null
          pricing_version?: string | null
          resource_id?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_records_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_records_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_records_pricing_rule_id_fkey"
            columns: ["pricing_rule_id"]
            isOneToOne: false
            referencedRelation: "pricing_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_records_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "provider_resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cost_records_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      metric_definitions: {
        Row: {
          aggregation: string
          derivation: string
          description: string
          key: string
          name: string
          provider: string
          scope_level: string
          supported: boolean
          unit: string
          unsupported_reason: string | null
          updated_at: string
        }
        Insert: {
          aggregation: string
          derivation: string
          description?: string
          key: string
          name: string
          provider: string
          scope_level: string
          supported?: boolean
          unit: string
          unsupported_reason?: string | null
          updated_at?: string
        }
        Update: {
          aggregation?: string
          derivation?: string
          description?: string
          key?: string
          name?: string
          provider?: string
          scope_level?: string
          supported?: boolean
          unit?: string
          unsupported_reason?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      notification_deliveries: {
        Row: {
          alert_id: string
          attempts: number
          channel: string
          created_at: string
          id: string
          last_error: string | null
          next_attempt_at: string
          read_at: string | null
          recipient: string | null
          sent_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          alert_id: string
          attempts?: number
          channel: string
          created_at?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          read_at?: string | null
          recipient?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          alert_id?: string
          attempts?: number
          channel?: string
          created_at?: string
          id?: string
          last_error?: string | null
          next_attempt_at?: string
          read_at?: string | null
          recipient?: string | null
          sent_at?: string | null
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          code_verifier_ciphertext: string
          connection_id: string | null
          created_at: string
          expires_at: string
          provider: string
          state: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          code_verifier_ciphertext: string
          connection_id?: string | null
          created_at?: string
          expires_at?: string
          provider: string
          state: string
          user_id: string
          workspace_id: string
        }
        Update: {
          code_verifier_ciphertext?: string
          connection_id?: string | null
          created_at?: string
          expires_at?: string
          provider?: string
          state?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_states_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "oauth_states_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      pricing_rules: {
        Row: {
          billing_mode: string
          currency: string
          id: string
          included_quantity: number
          metric_key: string
          notes: string | null
          plan: string
          provider: string
          source_url: string | null
          unit_price: number
          unit_size: number
          updated_at: string
          verified_at: string
          version: string
        }
        Insert: {
          billing_mode?: string
          currency: string
          id: string
          included_quantity?: number
          metric_key: string
          notes?: string | null
          plan: string
          provider: string
          source_url?: string | null
          unit_price: number
          unit_size?: number
          updated_at?: string
          verified_at: string
          version: string
        }
        Update: {
          billing_mode?: string
          currency?: string
          id?: string
          included_quantity?: number
          metric_key?: string
          notes?: string | null
          plan?: string
          provider?: string
          source_url?: string | null
          unit_price?: number
          unit_size?: number
          updated_at?: string
          verified_at?: string
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "pricing_rules_metric_key_fkey"
            columns: ["metric_key"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["key"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_accounts: {
        Row: {
          account_type: string
          billing_currency: string | null
          billing_cycle_anchor_day: number
          connection_id: string
          dashboard_url: string | null
          external_id: string
          first_seen_at: string
          id: string
          last_seen_at: string
          metadata: Json
          name: string
          plan: string | null
          provider: string
          status: string
          workspace_id: string
        }
        Insert: {
          account_type?: string
          billing_currency?: string | null
          billing_cycle_anchor_day?: number
          connection_id: string
          dashboard_url?: string | null
          external_id: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          name: string
          plan?: string | null
          provider: string
          status?: string
          workspace_id: string
        }
        Update: {
          account_type?: string
          billing_currency?: string | null
          billing_cycle_anchor_day?: number
          connection_id?: string
          dashboard_url?: string | null
          external_id?: string
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          metadata?: Json
          name?: string
          plan?: string | null
          provider?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_accounts_connection_id_workspace_id_fkey"
            columns: ["connection_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "provider_accounts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_connections: {
        Row: {
          auth_method: string
          capabilities: Json
          consecutive_failures: number
          created_at: string
          created_by: string | null
          disconnected_at: string | null
          granted_scopes: string[]
          id: string
          label: string
          last_attempt_at: string | null
          last_discovery_at: string | null
          last_error_code: string | null
          last_manual_sync_at: string | null
          last_success_at: string | null
          locked_until: string | null
          next_sync_at: string | null
          provider: string
          status: string
          status_changed_at: string
          status_detail: string | null
          sync_interval_minutes: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          auth_method: string
          capabilities?: Json
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          disconnected_at?: string | null
          granted_scopes?: string[]
          id?: string
          label: string
          last_attempt_at?: string | null
          last_discovery_at?: string | null
          last_error_code?: string | null
          last_manual_sync_at?: string | null
          last_success_at?: string | null
          locked_until?: string | null
          next_sync_at?: string | null
          provider: string
          status?: string
          status_changed_at?: string
          status_detail?: string | null
          sync_interval_minutes?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          auth_method?: string
          capabilities?: Json
          consecutive_failures?: number
          created_at?: string
          created_by?: string | null
          disconnected_at?: string | null
          granted_scopes?: string[]
          id?: string
          label?: string
          last_attempt_at?: string | null
          last_discovery_at?: string | null
          last_error_code?: string | null
          last_manual_sync_at?: string | null
          last_success_at?: string | null
          locked_until?: string | null
          next_sync_at?: string | null
          provider?: string
          status?: string
          status_changed_at?: string
          status_detail?: string | null
          sync_interval_minutes?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_connections_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_credentials: {
        Row: {
          ciphertext: string
          connection_id: string
          created_at: string
          expires_at: string | null
          key_version: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          ciphertext: string
          connection_id: string
          created_at?: string
          expires_at?: string | null
          key_version?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          ciphertext?: string
          connection_id?: string
          created_at?: string
          expires_at?: string | null
          key_version?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_credentials_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: true
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_credentials_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_resources: {
        Row: {
          account_id: string | null
          connection_id: string
          dashboard_url: string | null
          external_id: string
          first_seen_at: string
          id: string
          is_monitored: boolean
          last_collected_at: string | null
          last_seen_at: string
          metadata: Json
          name: string
          plan: string | null
          provider: string
          provider_status: string | null
          region: string | null
          resource_type: string
          status: string
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          connection_id: string
          dashboard_url?: string | null
          external_id: string
          first_seen_at?: string
          id?: string
          is_monitored?: boolean
          last_collected_at?: string | null
          last_seen_at?: string
          metadata?: Json
          name: string
          plan?: string | null
          provider: string
          provider_status?: string | null
          region?: string | null
          resource_type: string
          status?: string
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          connection_id?: string
          dashboard_url?: string | null
          external_id?: string
          first_seen_at?: string
          id?: string
          is_monitored?: boolean
          last_collected_at?: string | null
          last_seen_at?: string
          metadata?: Json
          name?: string
          plan?: string | null
          provider?: string
          provider_status?: string | null
          region?: string | null
          resource_type?: string
          status?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_resources_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_resources_connection_id_workspace_id_fkey"
            columns: ["connection_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "provider_resources_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      quota_evaluations: {
        Row: {
          computed_at: string
          cost: Json
          coverage: Json
          current_value: number | null
          cycle_end: string | null
          cycle_start: string | null
          data_state: string
          data_updated_at: string | null
          forecast: Json
          is_effective: boolean
          limit_value: number | null
          percent_used: number | null
          quota_rule_id: string
          workspace_id: string
        }
        Insert: {
          computed_at?: string
          cost?: Json
          coverage?: Json
          current_value?: number | null
          cycle_end?: string | null
          cycle_start?: string | null
          data_state: string
          data_updated_at?: string | null
          forecast?: Json
          is_effective?: boolean
          limit_value?: number | null
          percent_used?: number | null
          quota_rule_id: string
          workspace_id: string
        }
        Update: {
          computed_at?: string
          cost?: Json
          coverage?: Json
          current_value?: number | null
          cycle_end?: string | null
          cycle_start?: string | null
          data_state?: string
          data_updated_at?: string | null
          forecast?: Json
          is_effective?: boolean
          limit_value?: number | null
          percent_used?: number | null
          quota_rule_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quota_evaluations_quota_rule_id_fkey"
            columns: ["quota_rule_id"]
            isOneToOne: true
            referencedRelation: "quota_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quota_evaluations_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      quota_rules: {
        Row: {
          account_id: string | null
          created_at: string
          created_by: string | null
          id: string
          limit_value: number | null
          metric_key: string
          notes: string | null
          overage_effect: string
          period: string
          plan_hint: string | null
          pricing_rule_id: string | null
          resource_id: string | null
          scope_type: string
          source: string
          thresholds: Json | null
          unit: string
          updated_at: string
          verified_at: string | null
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          limit_value?: number | null
          metric_key: string
          notes?: string | null
          overage_effect?: string
          period?: string
          plan_hint?: string | null
          pricing_rule_id?: string | null
          resource_id?: string | null
          scope_type: string
          source: string
          thresholds?: Json | null
          unit: string
          updated_at?: string
          verified_at?: string | null
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          limit_value?: number | null
          metric_key?: string
          notes?: string | null
          overage_effect?: string
          period?: string
          plan_hint?: string | null
          pricing_rule_id?: string | null
          resource_id?: string | null
          scope_type?: string
          source?: string
          thresholds?: Json | null
          unit?: string
          updated_at?: string
          verified_at?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quota_rules_account_id_workspace_id_fkey"
            columns: ["account_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "quota_rules_metric_key_fkey"
            columns: ["metric_key"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "quota_rules_pricing_rule_id_fkey"
            columns: ["pricing_rule_id"]
            isOneToOne: false
            referencedRelation: "pricing_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quota_rules_resource_id_workspace_id_fkey"
            columns: ["resource_id", "workspace_id"]
            isOneToOne: false
            referencedRelation: "provider_resources"
            referencedColumns: ["id", "workspace_id"]
          },
          {
            foreignKeyName: "quota_rules_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_runs: {
        Row: {
          connection_id: string
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          id: string
          started_at: string
          stats: Json
          status: string
          trigger: string
          workspace_id: string
        }
        Insert: {
          connection_id: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          stats?: Json
          status?: string
          trigger: string
          workspace_id: string
        }
        Update: {
          connection_id?: string
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          id?: string
          started_at?: string
          stats?: Json
          status?: string
          trigger?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sync_runs_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sync_runs_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_samples: {
        Row: {
          account_id: string | null
          aggregation: string
          bucket_end: string
          bucket_start: string
          collected_at: string
          connection_id: string
          dimensions: Json | null
          id: number
          metric_key: string
          observed_at: string
          quality: string
          resource_id: string | null
          source: string
          sync_run_id: string | null
          unit: string
          value: number
          workspace_id: string
        }
        Insert: {
          account_id?: string | null
          aggregation: string
          bucket_end: string
          bucket_start: string
          collected_at?: string
          connection_id: string
          dimensions?: Json | null
          id?: never
          metric_key: string
          observed_at: string
          quality?: string
          resource_id?: string | null
          source: string
          sync_run_id?: string | null
          unit: string
          value: number
          workspace_id: string
        }
        Update: {
          account_id?: string | null
          aggregation?: string
          bucket_end?: string
          bucket_start?: string
          collected_at?: string
          connection_id?: string
          dimensions?: Json | null
          id?: never
          metric_key?: string
          observed_at?: string
          quality?: string
          resource_id?: string | null
          source?: string
          sync_run_id?: string | null
          unit?: string
          value?: number
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_samples_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_samples_connection_id_fkey"
            columns: ["connection_id"]
            isOneToOne: false
            referencedRelation: "provider_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_samples_metric_key_fkey"
            columns: ["metric_key"]
            isOneToOne: false
            referencedRelation: "metric_definitions"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "usage_samples_resource_id_fkey"
            columns: ["resource_id"]
            isOneToOne: false
            referencedRelation: "provider_resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_samples_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_members: {
        Row: {
          created_at: string
          role: string
          user_id: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          role?: string
          user_id: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          role?: string
          user_id?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_members_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          alert_email: string | null
          created_at: string
          email_min_severity: string
          id: string
          name: string
          notify_email: boolean
          notify_in_app: boolean
          owner_id: string
          stale_after_hours: number
          updated_at: string
        }
        Insert: {
          alert_email?: string | null
          created_at?: string
          email_min_severity?: string
          id?: string
          name: string
          notify_email?: boolean
          notify_in_app?: boolean
          owner_id: string
          stale_after_hours?: number
          updated_at?: string
        }
        Update: {
          alert_email?: string | null
          created_at?: string
          email_min_severity?: string
          id?: string
          name?: string
          notify_email?: boolean
          notify_in_app?: boolean
          owner_id?: string
          stale_after_hours?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_connection: {
        Args: { p_connection_id: string; p_lock_minutes?: number }
        Returns: {
          auth_method: string
          capabilities: Json
          consecutive_failures: number
          created_at: string
          created_by: string | null
          disconnected_at: string | null
          granted_scopes: string[]
          id: string
          label: string
          last_attempt_at: string | null
          last_discovery_at: string | null
          last_error_code: string | null
          last_manual_sync_at: string | null
          last_success_at: string | null
          locked_until: string | null
          next_sync_at: string | null
          provider: string
          status: string
          status_changed_at: string
          status_detail: string | null
          sync_interval_minutes: number
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "provider_connections"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_connections: {
        Args: { p_limit?: number; p_lock_minutes?: number }
        Returns: {
          auth_method: string
          capabilities: Json
          consecutive_failures: number
          created_at: string
          created_by: string | null
          disconnected_at: string | null
          granted_scopes: string[]
          id: string
          label: string
          last_attempt_at: string | null
          last_discovery_at: string | null
          last_error_code: string | null
          last_manual_sync_at: string | null
          last_success_at: string | null
          locked_until: string | null
          next_sync_at: string | null
          provider: string
          status: string
          status_changed_at: string
          status_detail: string | null
          sync_interval_minutes: number
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "provider_connections"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      claim_due_deliveries: {
        Args: { p_limit?: number }
        Returns: {
          alert_id: string
          attempts: number
          channel: string
          created_at: string
          id: string
          last_error: string | null
          next_attempt_at: string
          read_at: string | null
          recipient: string | null
          sent_at: string | null
          status: string
          updated_at: string
          workspace_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "notification_deliveries"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      is_workspace_member: { Args: { ws: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

